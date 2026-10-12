# HTTP API

Base URL: `https://<your-server>`. All request and response bodies are JSON.
Owner routes require `Authorization: Bearer <owner token>`.

`OWNER_API_TOKENS` is a comma separated list; the first token is the one the
examples below call `$TOKEN`.

## Health

### `GET /healthz`

```json
{
  "status": "ok",
  "service": "nexus-phone-agent",
  "version": "0.1.0",
  "env": "production",
  "uptime_seconds": 42,
  "protocol_version": 1
}
```

Always public; it reports liveness only.

### `GET /readyz`

Readiness: storage reachable, AI provider state, gateway state. Returns `503`
with the same shape when a dependency is not ready.

### `GET /api/v1/status`

Owner-visible overview: version, environment, effective limits, storage driver,
WebSocket statistics and the paired devices.

## Pairing

### `POST /api/v1/pair` — create a code (owner only)

```bash
curl -X POST https://server/api/v1/pair \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"create","label":"J7 Prime"}'
```

```json
{
  "pairing_id": "pair_…",
  "code": "ABCD-EFGH",
  "expires_at": "2026-10-11T12:05:00.000Z",
  "expires_in_seconds": 300,
  "ws_url": "wss://server/api/v1/device",
  "hint": "Enter this code in the NEXUS app within the expiry window. It can be used once."
}
```

### `POST /api/v1/pair` — redeem a code (the phone, no token)

```bash
curl -X POST https://server/api/v1/pair \
  -H "content-type: application/json" \
  -d '{"action":"complete","code":"ABCD-EFGH","client":{"app_version":"0.1.0","android_version":"9","device_model":"SM-J730F","accessibility_enabled":false}}'
```

```json
{
  "device_id": "dev_…",
  "device_token": "…",
  "device": { "device_id": "dev_…", "label": null, "online": false },
  "ws_url": "wss://server/api/v1/device",
  "protocol_version": 1,
  "hint": "Store this token now. It is shown once and cannot be recovered."
}
```

The token is returned **once**. It is rate limited per IP and locked out after
`PAIRING_MAX_ATTEMPTS` failures inside `PAIRING_FAILURE_WINDOW_SECONDS`.

Errors: `PAIRING_INVALID`, `PAIRING_EXPIRED`, `PAIRING_USED`, `PAIRING_LOCKED`.

## Devices

### `GET /api/v1/devices`

```json
{ "devices": [{ "device_id": "dev_…", "label": "J7 Prime", "online": true, "connection_state": "connected", "last_seen_at": "…" }] }
```

### `POST /api/v1/devices/:deviceId/revoke`

Revokes the credential. The connected phone receives `device_revoked` and wipes
its local copy. Returns the updated public record.

## Tasks

### `POST /api/v1/tasks`

```bash
curl -X POST https://server/api/v1/tasks \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"device_id":"dev_…","instruction":"Open YouTube"}'
```

`202 Accepted` with the serialized task. Execution is asynchronous: watch
`/api/v1/tasks/:taskId` or the bot.

Instruction rules: 1–1000 characters, no control characters.

### `GET /api/v1/tasks?limit=20&device_id=dev_…`

### `GET /api/v1/tasks/:taskId`

```json
{
  "task_id": "task_…",
  "device_id": "dev_…",
  "instruction": "Open YouTube",
  "status": "completed",
  "source": "api",
  "created_at": "…",
  "started_at": "…",
  "finished_at": "…",
  "expires_at": "…",
  "active": false,
  "plan_summary": "Open YouTube",
  "action_count": 1,
  "completed_actions": 1,
  "requires_approval": false,
  "approval_state": "not_required",
  "result": { "summary": "…" },
  "error_code": null,
  "actions": [
    { "action_id": "action_…", "sequence": 1, "type": "open_app", "status": "succeeded",
      "error_code": null, "retry_count": 0, "started_at": "…", "finished_at": "…" }
  ]
}
```

`source` is `api`, `bot` or `device`.

### `POST /api/v1/tasks/:taskId/cancel`

### `POST /api/v1/tasks/:taskId/approve`

Only valid while `status` is `awaiting_approval`; otherwise `TASK_NOT_ACTIONABLE`.

### `POST /api/v1/tasks/:taskId/deny`

Cancels the task with `approval_state: "denied"`. Nothing is executed.

## Errors

Every error has the same shape:

```json
{ "error": { "code": "DEVICE_OFFLINE", "message": "The device is not currently connected." } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | Malformed body or parameters. |
| `INVALID_PROTOCOL_VERSION` | 400 | The device speaks another protocol version. |
| `AUTHENTICATION_REQUIRED` | 401 | Missing or wrong owner token. |
| `PERMISSION_DENIED` | 403 | Not your device or task. |
| `NOT_FOUND` | 404 | Unknown route or object. |
| `RATE_LIMITED` | 429 | Slow down. |
| `DEVICE_NOT_PAIRED` | 404 | The device is unknown or belongs to another owner. |
| `DEVICE_REVOKED` | 403 | The device credential was revoked. |
| `DEVICE_OFFLINE` | 409 | The device is not connected. |
| `DEVICE_BUSY` | 409 | The device already has an active task. |
| `ACCESSIBILITY_NOT_ENABLED` | 409 | The accessibility service is off on the phone. |
| `PAIRING_*` | 400/410/429 | See the pairing section. |
| `AI_PROVIDER_NOT_CONFIGURED` | 503 | No usable AI provider or model. |
| `AI_PROVIDER_INVALID_CREDENTIALS` | 502 | The provider rejected the key. |
| `AI_PROVIDER_RATE_LIMITED` | 429 | The provider throttled the request. |
| `AI_PROVIDER_TIMEOUT` | 504 | The provider did not answer in time. |
| `AI_PROVIDER_ERROR` | 502 | Any other provider failure. |
| `INVALID_AI_PLAN` | 502 | The model returned a plan that failed validation. |
| `ACTION_NOT_ALLOWED` | 400 | The plan touched a denied action. |
| `APPROVAL_REQUIRED` | 409 | The task is parked. |
| `TASK_LIMIT_EXCEEDED` | 429 | Action budget, duration or pending-queue limit reached. |
| `TASK_CANCELLED` | 409 | The task was cancelled. |
| `TASK_EXPIRED` | 410 | The task ran past its deadline. |
| `TASK_NOT_ACTIONABLE` | 409 | Illegal change for the current state. |
| `ACTION_TIMEOUT` | 504 | The device did not report in time. |
| `TARGET_NOT_FOUND` / `TARGET_AMBIGUOUS` / `SCREEN_BLOCKED` / `APP_NOT_INSTALLED` | 409/404 | Reported by the device. |

## Rate limits

| Route | Default |
| --- | --- |
| `POST /api/v1/pair` (create) | 10/min |
| `POST /api/v1/pair` (complete) | 20/min per IP |
| `POST /api/v1/tasks` | 20/min |
| WebSocket messages | 240/min per socket |

## Bot commands (Telegram)

Allowlisted by `TELEGRAM_ALLOWED_USER_IDS` and, when set,
`TELEGRAM_ALLOWED_CHAT_IDS`.

```
/help              this message
/status            server, AI and device status
/devices           list paired devices
/pair              create a pairing code (valid once)
/run <task>        send a task to your default device
/task <id>         show the progress of a task
/cancel <id>       cancel a task
/stop              cancel every unfinished task
/revoke <id>       revoke a device credential
```

`/pair` prints the code only — never a device token.
