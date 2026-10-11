# Device protocol v1

The phone and the server speak JSON over a single, TLS-protected WebSocket at
`wss://<server><WS_PATH>` (`WS_PATH` defaults to `/api/v1/device`).

Every message is an envelope:

```json
{
  "protocol_version": 1,
  "type": "…",
  "message_id": "msg_…",
  "sent_at": "2026-10-11T12:00:00.000Z"
}
```

* `protocol_version` is required and must be `1` on both sides.
* `message_id` is optional on the way in; when present the server suppresses
  duplicates.
* Both sides validate every inbound frame with a strict schema — unknown fields
  are rejected, not ignored. Source: `server/src/websocket/protocol.js` and
  `android/.../protocol/Protocol.java`.

## Connection sequence

```
phone                                        server
  │──── connect (wss) ─────────────────────►  │
  │──── device_hello ───────────────────────► │  authenticate the device token
  │◄─── device_auth_ok ────────────────────── │  heartbeat_interval_ms
  │──── device_status ──────────────────────► │
  │◄──────────── heartbeat / heartbeat_ack ──►│  every HEARTBEAT_INTERVAL_MS
```

The socket is only considered **connected** after `device_auth_ok`. The app
never displays "Connected" before that.

## Device → server

| Type | Fields | When |
| --- | --- | --- |
| `device_hello` | `device_id`, `device_token`, `client{app_version, android_version, device_model?, accessibility_enabled?}` | First message on every connection. |
| `heartbeat` | — | Every `heartbeat_interval_ms` (the phone uses 20 s and also sends one when the accessibility state changes). |
| `device_status` | `accessibility_enabled`, `battery_percent?`, `charging?` | After auth and whenever the accessibility state changes. |
| `action_result` | `task_id`, `action_id`, `sequence`, `status`, `error_code?`, `message?`, `duration_ms?`, `result?` | Once per dispatched action. |
| `task_progress` | `task_id`, `status`, `message?` | Informational (for example when the device accepts a task). |
| `task_create` | `request_id`, `instruction` | The owner typed an instruction on the phone. |
| `task_approve` / `task_deny` | `task_id` | The owner decided on a task parked in `awaiting_approval`. |
| `protocol_error` | `error_code`, `message?`, `ref_message_id?` | The phone refuses a frame it cannot honour. |

### `action_result.result`

Strictly shaped, so the planner only ever sees a small, redacted summary:

```json
{
  "summary": "Read 12 visible elements.",
  "package_name": "com.google.android.youtube",
  "matched": true,
  "match_count": 1,
  "scrolled": false,
  "elements": [{ "text": "Home", "content_description": "", "clickable": true }],
  "visible_text": ["Home", "Shorts"]
}
```

`elements` and `visible_text` are capped at 50 entries. Everything on the phone
passes through `Redactor` first: passwords, card numbers, long digit runs,
emails and tokens are replaced with `[hidden]`.

### Error codes the phone may report

`ACTION_TIMEOUT`, `APP_NOT_INSTALLED`, `TARGET_AMBIGUOUS`, `TARGET_NOT_FOUND`,
`ACCESSIBILITY_NOT_ENABLED`, `ACTION_NOT_ALLOWED`, `SCREEN_BLOCKED`,
`TASK_CANCELLED`, `INVALID_REQUEST`, `INTERNAL_ERROR`.

The executor's own vocabulary is mapped onto this list by
`NexusConnectionService.mapErrorCode()` — anything else becomes `INTERNAL_ERROR`.

## Server → device

| Type | Fields | Meaning |
| --- | --- | --- |
| `device_auth_ok` | `device_id`, `server_time`, `heartbeat_interval_ms`, `protocol_version` | Authenticated. |
| `device_auth_failed` | `error_code`, `message` | `AUTHENTICATION_REQUIRED`, `DEVICE_REVOKED`, `INVALID_PROTOCOL_VERSION`, `INVALID_REQUEST`, `RATE_LIMITED`. |
| `heartbeat_ack` | `server_time` | Liveness. |
| `task_dispatch` | `task_id`, `instruction`, `action_count`, `expires_at` | A task is starting. |
| `execute_action` | `task_id`, `action_id`, `sequence`, `expires_at`, `action` | Run exactly this action. |
| `cancel_task` | `task_id`, `reason` | `user_cancelled`, `task_expired`, `device_revoked`, `policy_denied`. |
| `approval_required` | `task_id`, `reasons[]` | Parked until the owner decides. |
| `task_completed` | `task_id`, `status`, `summary?`, `error_code?` | Terminal state. |
| `task_accepted` | `request_id`, `task_id`, `status` | Answer to `task_create`. |
| `task_rejected` | `request_id`, `error_code`, `message` | The task was refused before planning (for example `RATE_LIMITED`). |
| `approval_result` | `task_id`, `approved`, `status`, `error_code?`, `message?` | Answer to `task_approve` / `task_deny`. |
| `device_revoked` | `reason` | The credential is dead; the phone wipes it locally. |
| `protocol_error` | `error_code`, `message` | The server refused a frame. |

## Sequence numbers, retries and replay protection

* `sequence` starts at 1 for each task and increases by one per action.
* A retry keeps the same `sequence` and carries a **new `action_id`**, so the
  phone can tell "try that again" from "you already did that".
* The phone keeps, per task: the last `sequence`, the last `action_id` and the
  last `action_result` it sent.
  * same `action_id` again → the cached result is resent (idempotent replay);
  * `sequence` lower than the last one → `protocol_error` `STALE_SEQUENCE`;
  * `sequence` more than one ahead → `protocol_error` `SEQUENCE_GAP`;
  * a second `task_dispatch` while a task is running → `protocol_error` `DEVICE_BUSY`.
* The server correlates results by `task_id` + `action_id` and drops results it
  is not waiting for, so a late or forged result cannot influence a task.

## Limits enforced on the wire

| Limit | Default | Where |
| --- | --- | --- |
| Maximum frame size | 32 KB (`MAX_MESSAGE_BYTES`) | both sides |
| Messages per minute per socket | 240 (`WS_MESSAGE_RATE_PER_MINUTE`) | server |
| Heartbeat interval / timeout | 20 s / 60 s | server sends the interval, the phone obeys |
| Authentication window | 15 s (`AUTH_TIMEOUT_MS`) | server |
| Simultaneous device sockets | 50 (`MAX_WS_CONNECTIONS`) | server |
| Task creation from a device | 20/min (`TASK_CREATE_RATE_PER_MINUTE`) | server |

## Reconnection

The phone reconnects with exponential backoff (2 s → 4 s → 8 s → 15 s → 30 s →
60 s, plus up to 1 s of jitter). It does **not** retry after
`device_auth_failed` with `DEVICE_REVOKED` or `INVALID_PROTOCOL_VERSION`, or
after `device_revoked`: those need a human.
