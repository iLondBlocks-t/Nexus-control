# Contributing

Thanks for wanting to work on this. The rules below exist because this project
can tap on someone's real phone, and because a fake green checkmark is worse than
no checkmark at all.

## Ground rules

1. **No mockups and no fake success.** If something is not implemented, say so in
   the code comment, the docs and the PR description.
2. **No invented test results.** Only report a test as passing if you ran it.
   State what you did not run.
3. **No invented identifiers.** No guessed model names, endpoints, package names
   or API keys. Anything environment-specific belongs in `.env`, `.env.example` or
   a code constant that is obviously a placeholder.
4. **No credentials in the client.** The AI key never enters `android/`. The
   device token is runtime data, never a build-time constant.
5. **Keep the two allowlists identical.** `server/src/policies/actionSchema.js` is
   the source of truth; `android/.../policy/LocalPolicy.java` must match.
   `npm run android:check` enforces it.

## Setting up

```bash
npm ci
cp .env.example .env      # AI_PROVIDER=mock is fine for local work
npm run verify            # secrets + lint + android checks + tests
```

`AI_PROVIDER=mock` gives you a deterministic offline planner so the full pipeline
runs without a key. It is refused in production.

## Before you open a pull request

```bash
npm run lint
npm run check:secrets
npm run android:check
npm test
```

CI runs the same four, plus a Gradle build of the debug APK.

If you touched the client and you have a device, say in the PR which of the
verification steps in [docs/ANDROID_SETUP.md §6](docs/ANDROID_SETUP.md) you ran
on real hardware — and which you could not.

## Adding an action type

This is the change most likely to weaken the system, so it needs all of these:

1. `server/src/policies/actionSchema.js` — the schema (strict; no extra fields).
2. `server/src/policies/policyEngine.js` — whether it is sensitive, and why.
3. `android/.../policy/LocalPolicy.java` — validation on the phone.
4. `android/.../executor/ActionExecutor.java` — the real implementation.
5. `server/src/planner/planner.js` — describe it to the model only if it should be
   plannable.
6. Tests: at least one that proves a bad payload is refused, and one that proves
   the phone refuses it too.
7. `docs/PROTOCOL.md` and, if user visible, `docs/ARCHITECTURE.md`.

If the phone does not implement it, do not add it to the schema. An action that
exists in only one place is a bug.

## Style

**Server (Node.js, ESM)**

* `import`/`export`, no CommonJS; 2-space indent; semicolons.
* Validate at the boundary with `zod`; never trust a payload deeper in.
* Use the structured logger (`server/src/logging/logger.js`), never `console`.
  `npm run lint` fails on `console.log` in `server/src`.
* Errors go through `AppError` / `normalizeError` with a code from
  `server/src/utils/errors.js`.

**Android (Java)**

* Plain `Activity` + XML. **No AndroidX, no Kotlin, no Compose.**
* Keep dependencies at zero; if you need something, justify it in the PR.
* Anything that touches the UI lives behind `ActionExecutor` and returns a
  `Result` — it must not throw into the task loop.
* Text that leaves the phone goes through `util/Redactor` first.

## Tests

* One behaviour per test, named after the behaviour: "a denied task is cancelled
  and never executes" beats "test task denial".
* Use the helpers in `server/test/helpers/` (`startTestServer`, `FakeDevice`,
  `pairDevice`) — they boot a real server, not a mock of one.
* Concurrency: the suite runs with `--test-concurrency=1` on purpose. Do not
  introduce order-dependent tests.
* A failing test may be skipped only with a linked issue and a reason in the code.

## Commits and pull requests

* Small, focused commits. Imperative subject line.
* Explain **why** in the body; the diff already says what.
* Update the docs in the same PR as the behaviour change.
* If your change alters the protocol, bump it deliberately and say what breaks —
  do not silently tolerate a version mismatch.

## Reporting bugs

Include the server version, the Android version and device model, the exact
instruction you sent, the task id, and the relevant log lines (secrets are masked
automatically). [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) resolves most
first-run problems.

## Licence

Contributions are accepted under the MIT licence of this repository.
