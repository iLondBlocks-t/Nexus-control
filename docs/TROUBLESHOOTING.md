# Troubleshooting

Start with the two commands that tell you the truth:

```bash
npm run check:config     # what the server thinks its configuration is
npm run ai:doctor        # whether the AI provider is usable at all
```

## The phone never connects

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Not configured` | The server address is empty or not `https://`. | Set it in Settings. `http://` is refused on purpose. |
| `Waiting for pairing` | No device token on the phone. | Pair again (Setup screen). |
| `Connecting…` forever | TLS or routing problem, or the WebSocket upgrade is blocked. | Check the reverse proxy forwards `Upgrade` and `Connection` (see [DEPLOYMENT.md](./DEPLOYMENT.md)). |
| `Reconnecting…` with backoff | The server closed the socket. | Look for `ws.auth_failed` / ping timeouts in the server log. |
| `Authentication failed` | Wrong device id/token pair, or the device was revoked. | Re-pair the phone. |
| `Device revoked` | Revoked from the API or the bot. | Re-pair; the old token can never work again. |
| `Server unavailable` | DNS, TLS certificate, or the port is not reachable from the phone's network. | Open `https://server/healthz` **in the phone's browser**. |

Test the endpoint without the app:

```bash
curl -i https://nexus.example.com/healthz
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
     https://nexus.example.com/api/v1/device
```

The second command must answer `101 Switching Protocols`. A `200` or `404` means
the proxy is eating the upgrade.

## Certificate errors

The client never disables certificate validation, so an expired, self-signed or
hostname-mismatched certificate simply fails to connect. Use a real certificate
(Let's Encrypt via your proxy) whose CN/SAN matches the host in the server
address. A reverse proxy that terminates TLS with the wrong name will fail the
same way in the phone's browser, which is the fastest way to confirm it.

## "Accessibility service: disabled"

The app cannot enable it. Go to
`Settings → Accessibility → NEXUS Phone Agent → On`.

If the entry is missing:

* force-stop the app and reopen it (Android re-scans accessibility services on
  install);
* confirm the APK was built with the `<service>` and
  `res/xml/accessibility_service_config.xml` intact;
* some vendor ROMs hide third-party services behind a "Downloaded services"
  submenu.

If the toggle turns itself off, the phone's battery manager is killing the
service: disable battery optimisation for NEXUS.

## Tasks fail immediately

| Error | Meaning |
| --- | --- |
| `AI_PROVIDER_NOT_CONFIGURED` | No provider, or no model set. Run `npm run ai:doctor`. |
| `AI_PROVIDER_INVALID_CREDENTIALS` | The key was rejected. |
| `AI_PROVIDER_RATE_LIMITED` / `AI_PROVIDER_TIMEOUT` | Provider throttling or slowness. |
| `INVALID_AI_PLAN` | The model returned something that failed validation. Check `planner.*` log events; retry. |
| `ACTION_NOT_ALLOWED` | The plan touched a denied action; the policy engine blocked it before dispatch. |
| `DEVICE_OFFLINE` | The device socket is down. |
| `DEVICE_BUSY` | Another task is still running on that device. |
| `ACCESSIBILITY_NOT_ENABLED` | See above. |
| `TASK_LIMIT_EXCEEDED` | Action budget, duration, or the pending queue is full. |

### Model identifiers

If tasks fail with an AI error, first confirm the model in `.env` is one your
account can actually call. Identifiers change over time; do not copy one from a
blog post. `OPENAI_MODEL` is required and the server refuses a provider it
cannot validate.

## Actions fail on the phone

| Error | Meaning | What to do |
| --- | --- | --- |
| `APP_NOT_INSTALLED` | The package is not on the device. | Install the app, or phrase the task differently. |
| `TARGET_NOT_FOUND` | No element matched the text/description/id. | Be more specific, or let the planner read the screen first. |
| `TARGET_AMBIGUOUS` | More than three elements matched. | Say which one ("the second result", include more of the text). |
| `SCREEN_BLOCKED` | Lock screen or an unreadable window. | Unlock the phone. |
| `ACTION_TIMEOUT` | The element or screen never appeared. | Increase `MAX_ACTION_TIMEOUT_MS`, or check the app's own load time. |
| `TASK_CANCELLED` | You (or the deadline) stopped it. | Expected after **Stop**. |
| `ACTION_NOT_ALLOWED` (from the phone) | The capability is switched off in Settings, or the target is a password/card field. | Enable the capability or change the task. |

Use `read_visible_ui` implicitly: if a task depends on what is on screen (for
example "open the third conversation"), the planner is instructed to read the
screen first and re-plan. Only `MAX_PLANNING_ITERATIONS` (default 3) rounds happen.

## The task parks in `awaiting_approval`

That is the safety net working. The reasons are listed on the phone and in the
bot reply. Decide with:

* **Approve** / **Deny** on the phone's task screen,
* `POST /api/v1/tasks/:id/approve` or `/deny`,
* nothing — the task expires after `APPROVAL_TIMEOUT_SECONDS`.

Set `POLICY_SENSITIVE_MODE=deny` to refuse sensitive plans outright instead of
parking them.

## The bot does not answer

1. `TELEGRAM_ENABLED=true` **and** `TELEGRAM_BOT_TOKEN` **and** a non-empty
   `TELEGRAM_ALLOWED_USER_IDS` (a numeric id, not a username).
2. No webhook may be set: `getUpdates` (long polling) and webhooks are mutually
   exclusive. Delete it via
   `https://api.telegram.org/bot<TOKEN>/deleteWebhook`.
3. Only pre-approved user ids are served; anything else is ignored silently.
4. Rate limiting replies with "Rate limit reached."

## The connection drops repeatedly

* Heartbeat interval 20 s, timeout 60 s. If your mobile network idles out, lower
  `HEARTBEAT_INTERVAL_MS` and raise `HEARTBEAT_TIMEOUT_MS`.
* A proxy with an aggressive idle timeout (look at `proxy_read_timeout`) closes
  the socket between heartbeats.
* Battery optimisation can suspend the service. Exempt NEXUS.
* The phone stops retrying after `DEVICE_REVOKED` or `INVALID_PROTOCOL_VERSION`;
  everything else retries with backoff up to 60 s.

## Server will not start

`npm run check:config` prints the effective values and every warning.
Configuration is validated at boot: an out-of-range number is a hard error, and
safety ceilings (`MAX_ACTIONS_PER_TASK` ≤ 30, `MAX_TASK_DURATION_SECONDS` ≤ 900,
`MAX_PENDING_TASKS_PER_DEVICE` ≤ 50) cannot be exceeded.

Common ones:

* `OWNER_API_TOKENS` empty → everything is unauthenticated; a warning is printed.
* `AI_PROVIDER=mock` with `NODE_ENV=production` → refused.
* `TELEGRAM_ENABLED=true` without a token or allowlist → refused.
* SQLite driver without the optional dependency installed → the driver reports it
  at startup; use `json` instead.

## Logs

Set `LOG_FORMAT=pretty` locally. Useful events:

| Event | Meaning |
| --- | --- |
| `ws.gateway_started` | The device endpoint is mounted. |
| `ws.auth_failed` | A phone was rejected (reason in the payload). |
| `task.created` | A task was queued (source: `api`, `bot` or `device`). |
| `planner.plan_screened` | A plan passed (or failed) the policy engine. |
| `task.executor_error` | The task failed; the code is in the payload. |
| `ws.task_decision` | An approve/deny decision taken on a phone. |

Secrets are masked automatically. If you ever see a token in a log, that is a
bug — please report it.
