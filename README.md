# NEXUS Phone Agent

Run a task on your own Android phone by describing it in one sentence — from
your server, your terminal, your Telegram bot, or the phone itself.

```
you:  "Open YouTube"
bot:  task_01H… queued → planning → running → completed
      open_app com.google.android.youtube → succeeded (1.2 s)
```

NEXUS is **not** a cloud automation service and not a screen scraper for other
people's apps. It is a personal system with four parts that you host yourself:

| Part | What it is |
| --- | --- |
| **Android app** (Java, no AndroidX) | An accessibility-service client that executes one validated UI action at a time. |
| **Server** (Node.js + Express) | Pairing, device registry, task lifecycle, policy engine, WebSocket gateway. |
| **AI planner** | Runs **on the server only**. Proposes a plan; it never decides. |
| **Bot** (Telegram) | `/run`, `/task`, `/stop`, `/pair`, `/devices` — long polling, no webhook. |

The model proposes. The policy engine and the phone decide. Both validate every
action against the same allowlist, independently.

---

## Quick start

```bash
git clone https://github.com/iLondBlocks-t/Nexus-control.git
cd Nexus-control
npm ci
cp .env.example .env
$EDITOR .env            # OWNER_API_TOKENS, AI_PROVIDER, OPENAI_API_KEY, OPENAI_MODEL
npm run check:config    # what the server will actually use
npm run ai:doctor       # is the AI provider configured?
npm start
```

Open `https://your-server/healthz`. Then:

```bash
# 1. create a pairing code (owner token required)
curl -X POST https://your-server/api/v1/pair \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"action":"create","label":"J7 Prime"}'

# 2. build and install the app, enter the code, enable the accessibility service
cd android && ./gradlew :app:assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk

# 3. send a task
curl -X POST https://your-server/api/v1/tasks \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"device_id":"dev_…","instruction":"Open YouTube"}'
```

Full walkthroughs: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and
[docs/ANDROID_SETUP.md](docs/ANDROID_SETUP.md).

---

## How a task runs

```
1. instruction ──► TaskService validates, checks the device and the queue limits
2.              ──► Planner asks the model for a JSON plan
3. plan        ──► PolicyEngine screens every action (allowlist, sensitive check)
4.              ──► DeviceGateway dispatches task_dispatch, then execute_action
5. phone       ──► LocalPolicy validates AGAIN, ActionExecutor performs it
6. result      ──► action_result → next action, a retry, or the final report
```

Guards, all enforced in code and covered by tests:

* **Allowlist**: 9 action types, 17 settings targets. Nothing else can be executed.
* **Limits**: 12 actions per task (ceiling 30), 90 s per task (ceiling 900),
  2 retries per action, 3 planning rounds, one active task per device.
* **Approvals**: sensitive plans park in `awaiting_approval`; nothing executes until
  you approve on the phone, through the API, or in the bot. `POLICY_SENSITIVE_MODE=deny`
  refuses them outright.
* **Never**: password, PIN, CVV or card fields; typing anything credential-shaped;
  acting while the lock screen is up; following instructions found in screen text.
* **Transport**: `wss://` only, certificate and hostname always verified, sequence
  numbers per task with idempotent replay, heartbeats, message size and rate limits.

---

## Repository layout

```
server/src/            Node.js server (ESM, zero framework magic)
  config/              Zod-validated environment + hard safety ceilings
  pairing/ devices/    One-time codes; device registry and revocation
  planner/ ai/         Prompting, plan parsing, providers (openai | mock | none)
  policies/            actionSchema.js = the single source of truth
  tasks/               Service, executor, state machine
  websocket/           Gateway + protocol v1 schemas
  bot/                 Telegram long-polling adapter
  storage/             memory | json | sqlite
android/               Native Java client (AGP 8.5.2, minSdk 23, targetSdk 34)
  app/src/main/java/com/nexus/phoneagent/
    core/ net/ protocol/ policy/ executor/ service/ data/ ui/ util/
scripts/               lint, check-secrets, check-config, ai-doctor, check-android
docs/                  ARCHITECTURE · API · PROTOCOL · DEPLOYMENT
                       ANDROID_SETUP · SECURITY_MODEL · TROUBLESHOOTING
```

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` / `npm run dev` | Run the server (watch mode for `dev`). |
| `npm test` | 143 tests: config, pairing, AI, policy, storage, websocket, tasks, health, bot, end-to-end. |
| `npm run verify` | secrets + lint + Android checks + tests. |
| `npm run lint` | Static checks for `server/`, `server/test` and `scripts`. |
| `npm run check:secrets` | Fails if a credential-shaped value is committed. |
| `npm run check:config` | Prints the effective configuration and every warning. |
| `npm run ai:doctor` | Reports whether the AI provider is configured (it does not call it). |
| `npm run android:check` | Resource, manifest, allowlist-sync and protocol checks for the client. |
| `npm run android:apk` | `./gradlew :app:assembleDebug`. |

---

## Requirements

* **Server**: Node.js ≥ 22.5, a public HTTPS endpoint, and (for real planning) an
  OpenAI API key plus a model your account can call.
* **Phone**: Android 6.0 (API 23) or newer. Verified target: Samsung Galaxy J7
  Prime SM-J730F, Android 9, ARMv7, 3 GB RAM, unrooted.
* **Build**: JDK 17 + Gradle 8.9.

`OPENAI_MODEL` is required when `AI_PROVIDER=openai`. Model identifiers change —
use one your account can actually call, not one copied from a blog post.

---

## Verification status

Stated plainly, because "it compiles" and "it works" are different claims.

**Verified by automated tests (143 passing, ~18 s):**

* configuration validation, hard ceilings and warning output;
* pairing: creation, redemption, expiry, single use, lockout;
* device authentication, revocation, and rejection of unknown devices;
* the WebSocket gateway: authentication, rate limits, oversized frames, duplicates,
  heartbeats, correlation and replay/sequence handling;
* the policy engine: unknown action types, disallowed settings targets, sensitive
  actions, injection-shaped labels, action budgets;
* the planner: provider errors, malformed plans, re-planning with screen context;
* the task lifecycle: retries, cancellation mid-run, expiry, approval and denial;
* device-reported failures surfacing their own error codes;
* device-initiated tasks (`task_create`) and decisions (`task_approve` / `task_deny`),
  including the rule that a device can only decide on its own tasks;
* the storage contract across all three drivers;
* the bot: allowlists by user id **and** chat id, every command, long replies,
  rate limiting, and that the pairing code never leaks a device token.

**Verified by static analysis only:**

* the Android client. `npm run android:check` proves resource references resolve,
  the manifest matches the sources, no AndroidX/Kotlin crept in, no credential is
  embedded, the phone's allowlist is identical to the server's, and both sides
  declare protocol version 1.

**Not verified — you must do this on real hardware:**

* that the APK compiles and installs (no Android SDK in this environment; the
  Gradle wrapper JAR is committed, and CI regenerates it from the official
  Gradle 8.9 distribution — see [docs/ANDROID_SETUP.md](docs/ANDROID_SETUP.md));
* that the accessibility service behaves on your device and ROM;
* real UI interactions against real apps;
* battery behaviour over hours;
* the AI provider returning usable plans with your key, model and data.

Follow the six-step check in
[docs/ANDROID_SETUP.md §6](docs/ANDROID_SETUP.md) the first time you run it.

---

## Security

Read [SECURITY.md](SECURITY.md) before exposing the server, and
[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) for the full model, including
what is **not** protected. The short version:

* the AI key lives only on your server — never in the APK;
* every action is screened twice, once on the server and once on the phone;
* the device token is stored hashed on the server and in app-private storage on
  the phone (a sandbox guarantee, not hardware-backed — see the security model);
* the accessibility service is bound, not exported, and only acts while you have
  sent a task.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: keep the two
allowlists in sync, never invent a test result, and never put a credential in the
client.

## Licence

MIT.
