# Architecture

NEXUS Phone Agent is a personal automation system with four parts:

```
        owner                                  owner's own server                     phone
┌──────────────────────┐            ┌───────────────────────────────┐      ┌──────────────────────────┐
│ Telegram bot  (CLI)  │  HTTPS     │  Express API  /api/v1         │      │  NEXUS app               │
│  /run /task /stop    │ ─────────► │  pairing, devices, tasks      │      │  NexusConnectionService  │
└──────────────────────┘            │                               │      │  (WebSocket client)      │
                                    │  TaskService  ──► Planner     │  wss │            │             │
                                    │      │            (AI)        │ ◄──► │            ▼             │
                                    │      ▼                        │      │  NexusAccessibilityService│
                                    │  PolicyEngine (allowlist)     │      │  ActionExecutor          │
                                    │      │                        │      │  LocalPolicy             │
                                    │      ▼                        │      └──────────────────────────┘
                                    │  DeviceGateway (WebSocket)    │
                                    └───────────────────────────────┘
```

The phone is a **client that executes validated actions**. It is never the
decision maker, and the AI model is never on the phone.

## Server (`server/src`)

| Path | Responsibility |
| --- | --- |
| `index.js` | Boots the process: config, storage, registry, gateway, executor, bot. Exported as `createServer()` so tests boot a real instance. |
| `app.js` | Express composition only: middleware, routers, error handler. |
| `config/` | Zod-validated environment; hard ceilings that configuration cannot exceed. |
| `auth/ownerAuth.js` | Owner API token (`Authorization: Bearer …`), optional on the pairing route. |
| `auth/deviceAuth.js` | Device token verification (SHA-256 hash comparison, never stored in clear text). |
| `pairing/pairingService.js` | One-time codes with TTL, attempt limits and lockout. |
| `devices/deviceRegistry.js` | Device records, revocation, `requireControllable()`. |
| `planner/planner.js` | Builds the model prompt, parses the plan, hands it to the policy engine. |
| `ai/` | `openaiProvider.js` (Chat Completions / Responses style JSON planning), `mockProvider.js` (offline, dev/test only), `provider.js` (selection). |
| `policies/` | `actionSchema.js` — the **single source of truth** for the action allowlist; `policyEngine.js` — screens every plan. |
| `tasks/` | `taskService.js` (validation + legal state transitions), `executor.js` (dispatch, retries, approvals, expiry), `stateMachine.js`. |
| `websocket/` | `gateway.js` (upgrades, auth, rate limits, heartbeats, correlation), `protocol.js` (v1 schemas), `connectionManager.js`. |
| `bot/` | Telegram long-polling adapter, allowlisted by user id and chat id. |
| `storage/` | `memory`, `json` and `sqlite` drivers behind one contract. |
| `logging/` | Structured JSON logger with secret redaction. |

### Task lifecycle

```
queued → planning → running → completed
                 ↘ awaiting_approval → running
                 ↘ failed | cancelled | expired
```

* Planning runs at most `MAX_PLANNING_ITERATIONS` (default 3) rounds.
* Each round produces a plan that **must** pass `screenPlan()` before a single
  action is dispatched.
* Each action may be retried up to `MAX_ACTION_RETRIES` (default 2) times.
  A retry keeps the same `sequence` and gets a **new `action_id`** — that is how
  the device tells a replay from a retry.
* The whole task is bounded by `MAX_TASK_DURATION_SECONDS` (default 90).
* Exactly one active task per device; `MAX_PENDING_TASKS_PER_DEVICE` bounds the queue.

## Android client (`android/app/src/main/java/com/nexus/phoneagent`)

| Package | Responsibility |
| --- | --- |
| `core/` | `Config` (SharedPreferences settings), `SecureStore` (device token). |
| `net/` | `WebSocketClient` (RFC 6455, TLS-verified, no library), `PairingClient` (HTTPS code redemption). |
| `protocol/` | `Protocol` — mirrors `server/src/websocket/protocol.js`: builders and validation. |
| `policy/` | `LocalPolicy` — the **second, independent** allowlist check before any UI action. |
| `executor/` | `ActionExecutor` — open app/settings, tap, scroll, type, wait, read screen, back, stop. |
| `service/` | `NexusAccessibilityService` (the only component that touches the screen), `NexusConnectionService` (foreground service: socket, heartbeat, backoff, task bookkeeping). |
| `data/` | `TaskStore` — JSON history in the app's private files directory. |
| `ui/` | Five activities: Setup, Main (dashboard), Task (input + progress), Task details, Settings. |
| `util/` | `Redactor` — strips anything credential-shaped before text leaves the phone. |

### Two independent gates

Every action is checked twice, on purpose:

1. **Server** — `actionSchema.js` + `policyEngine.js`, before dispatch.
2. **Phone** — `LocalPolicy.validate()`, before execution.

The phone also refuses when:

* the accessibility service is disabled (`ACCESSIBILITY_NOT_ENABLED`),
* the keyguard is locked (`SCREEN_BLOCKED`),
* the action type is switched off in Settings,
* the target label looks like an injected instruction ("ignore previous
  instructions", "system prompt", …),
* the target is a password, PIN or card field,
* the task is past its deadline or the message's `expires_at`.

## Design decisions

| Decision | Why |
| --- | --- |
| Java, no Kotlin | Requirement; keeps the toolchain small on a 3 GB device. |
| No AndroidX / Compose | Requirement; the UI is plain `Activity` + XML with the platform theme. |
| Hand-written WebSocket client | Zero dependencies means no supply-chain risk in the component that holds the device credential. |
| Device token in SharedPreferences | App-sandbox protected; the honest trade-off is documented in `SECURITY_MODEL.md`. |
| No AI key on the phone | The model runs only on the owner's server. Nothing in the APK can reach an AI provider. |
| Instruction submitted over the device socket | The phone holds no owner API token; the server applies the same validation, planning, policy and rate limits as the HTTP API. |
| `org.json` on Android, `zod` on the server | Both are the natural, dependency-free choice on each side; the schemas are kept in sync and verified by `npm run android:check`. |
