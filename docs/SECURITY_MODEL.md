# Security model

This document states what NEXUS protects, how, and — just as importantly — what
it does **not** protect.

## Trust boundaries

| Boundary | Protection |
| --- | --- |
| Owner ↔ server (API) | HTTPS + `Authorization: Bearer <owner token>`. |
| Owner ↔ server (bot) | Telegram; allowlisted by user id and, optionally, chat id. |
| Phone ↔ server | `wss://` only. TLS certificate and hostname are always verified; certificate validation is never disabled. Device token in the first message, not in the URL (URLs get logged). |
| Server ↔ AI provider | HTTPS; the key lives only in the server process environment. |
| Any app ↔ the phone | The accessibility service is bound with `BIND_ACCESSIBILITY_SERVICE` and is not exported. No component accepts intents from other apps. |
| Anyone ↔ local data | App-private storage (SharedPreferences, internal files). No content provider, no backup, no cloud sync. |

## Credentials

| Secret | Where it lives | Notes |
| --- | --- | --- |
| AI provider key | Server environment only | Never in the APK, never logged (registered with the redactor at boot). |
| Owner API token | Server environment; your CLI/bot config | Not on the phone. |
| Device token | On the phone, in `SharedPreferences` (`nexus.credentials`) | Stored **hashed** (SHA-256) on the server, so a server backup cannot be replayed as a phone. |
| Pairing code | Memory + store until redeemed or expired | One use, short TTL, lockout after repeated failures. |
| Telegram bot token | Server environment | Redacted in logs. |

### Honest limitation about the device token

On Android 9 there is no hardware-backed keystore API that is both available and
practical for a string secret without a user-facing unlock prompt on every
connection, so the token is kept in the app's private `SharedPreferences`. That
is protected by the Android app sandbox: on a non-rooted device no other app can
read it, and it is excluded from backups. It is **not** equivalent to a
Secure Enclave or StrongBox. If your threat model includes an attacker with
physical access to an unlocked, rooted device, treat the token as exposed and
revoke the device.

Ways to limit the blast radius:

* revoke from the server (`POST /api/v1/devices/:id/revoke`) or the bot
  (`/revoke <id>`) — takes effect immediately, the phone wipes its copy;
* use **Revoke local credentials** in the app when you stop using a phone;
* the token is scoped to one device and can only open the device socket.

## Two independent allowlists

Nothing reaches the UI unless **both** agree.

1. **Server** (`server/src/policies/`) — the single source of truth
   (`actionSchema.js`) plus `policyEngine.js`, applied to every plan before
   dispatch. Unknown action types are rejected; the schema is strict, so extra
   fields are an error, not a hint.
2. **Phone** (`policy/LocalPolicy.java`) — re-validates every action it receives,
   so a compromised or buggy server still cannot make the phone do something the
   owner has not allowed.

`npm run android:check` fails the build if the two lists ever drift apart.

## What is always refused

* Anything outside the nine allowlisted action types.
* Opening a settings screen outside the seventeen allowlisted targets.
* Interacting with a password, PIN, CVV or card field
  (`Redactor.isSensitiveFieldLabel`, `AccessibilityNodeInfo.isPassword()`).
* Typing anything that looks like a credential, an OTP or a long digit run.
* A label that looks like prompt injection ("ignore previous instructions",
  "system prompt", "new instructions:").
* Acting while the keyguard is locked → `SCREEN_BLOCKED`.
* Acting while the accessibility service is disabled → `ACCESSIBILITY_NOT_ENABLED`.
* More than one active task per device → `DEVICE_BUSY`.
* More actions than the budget, or running past the deadline.

## Sensitive actions

`POLICY_SENSITIVE_MODE` (default `approval`):

* a plan containing a sensitive action is parked in `awaiting_approval`;
* the phone receives `approval_required` with the reasons and nothing executes;
* the owner approves or denies on the phone (`task_approve` / `task_deny` over
  the authenticated socket), through the API, or via the bot;
* with `POLICY_SENSITIVE_MODE=deny` the plan is refused outright.

The server is the authority for approval. The phone records that an action was
flagged as sensitive, and the server's policy engine is what gates it.

## Prompt injection

Two layers:

1. **On the phone** — `Redactor` and `LocalPolicy` reject or neutralise
   instructions embedded in screen text before they are sent, and reject labels
   that look like commands.
2. **On the server** — screen content is passed to the model as *data* inside a
   delimited block, with an explicit instruction that it is untrusted and must
   never override the owner's instruction (see `planner/planner.js`).

Screen text is also redacted: emails, long digit runs and credential-shaped
strings are replaced with `[hidden]` before leaving the phone.

## Logging

* Structured JSON, levels configurable.
* Secrets are registered with the logger's redactor at boot
  (`protectSecret`) and masked wherever they would appear.
* Logs never contain the device token, the AI key, or the full screen dump —
  only redacted summaries and counts.
* `npm run check:secrets` scans tracked files for credential-shaped values and
  fails if one is committed.

## Network hardening

* Message size limit (32 KB default), per-socket rate limit, per-IP upgrade limit.
* Authentication must complete within `AUTH_TIMEOUT_MS`.
* Heartbeat + ping/pong with a dead-socket timeout; the phone reconnects with
  capped exponential backoff and stops retrying on terminal auth failures.
* Sequence numbers per task with idempotent replay (same `action_id` → the cached
  result is resent; older sequence → refused; a gap → refused).
* Results are correlated by `task_id` + `action_id`; uncorrelated results are
  dropped.

## Known limitations — read this before trusting it

1. **The device token is filesystem storage**, protected by the app sandbox. See
   above.
2. **No certificate pinning.** TLS is verified against the system trust store. On
   a device where an attacker can install a trusted CA, they can intercept the
   connection. If you need pinning, add it to `net/WebSocketClient.java` for your
   own host.
3. **An accessibility service is powerful by design.** It can read the visible
   screen and tap on your behalf. It works only while you send a task, stops on
   **Stop**, and never reads password fields, but you are granting it real
   capability.
4. **The AI model is not a security boundary.** It proposes; the policy engine
   and the phone decide. A model that returns nonsense fails validation rather
   than executing.
5. **Task history is plaintext JSON in app-private storage.** It contains the
   instructions you typed and the results. Clear it with **Revoke local
   credentials**.
6. **No automated tests for the Android client.** The server, bot, planner,
   policy engine and the protocol between them are covered by the Node test
   suite; the on-device code is covered by static checks (`npm run android:check`)
   and by the manual verification steps in [ANDROID_SETUP.md](./ANDROID_SETUP.md).
7. **Side-channel risk on a shared device.** Anyone who can unlock the phone can
   open NEXUS and send a task. Use a screen lock.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
