# Android setup and build

Target device for this project: **Samsung Galaxy J7 Prime (SM-J730F)**, Android 9
(API 28), ARMv7 32-bit, 3 GB RAM, not rooted. The app supports API 23+ and needs
no native libraries.

## 1. What you need to build

| Tool | Version |
| --- | --- |
| JDK | 17 |
| Gradle | 8.9 (AGP 8.5.2 requires 8.7+) |
| Android SDK | compileSdk 34, build-tools 34.x |

A Gradle wrapper JAR is committed at `android/gradle/wrapper/gradle-wrapper.jar`,
so `./gradlew` works out of the box: it downloads Gradle 8.9 (named in
`gradle-wrapper.properties`) and runs the build with it.

If your policy forbids committed binaries, delete the JAR and regenerate it from
an official Gradle installation:

```bash
gradle -p android wrapper --gradle-version 8.9 --distribution-type bin
```

That rewrites `gradlew`, `gradlew.bat` and `gradle/wrapper/gradle-wrapper.jar`
from the official distribution. CI does exactly this (see
`.github/workflows/build.yml`), so the build never has to trust a binary whose
origin cannot be shown. Without the JAR, `./gradlew` exits with code 2 and prints
these instructions instead of pretending to build.

## 2. Build

```bash
cd android
./gradlew :app:assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease   # unsigned release build
```

From the repository root, `npm run android:apk` runs the debug build, and
`npm run android:check` runs the static source checks (see below).

### Signing a release build

Nothing is signed by default and no keystore is committed. Create your own and
point `android/app/build.gradle` at it, or sign manually:

```bash
keytool -genkeypair -v -keystore nexus.jks -keyalg RSA -keysize 2048 \
        -validity 10000 -alias nexus
# then add a signingConfig to android/app/build.gradle (never commit the keystore)
```

`.gitignore` excludes `*.keystore`, `*.jks` and `*.apk`.

## 3. Install on the phone

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

or copy the APK to the device and open it (allow "install unknown apps" for your
file manager only, then turn it off again).

## 4. First run

1. Open **NEXUS**.
2. **Server address**: `https://nexus.example.com` — `https://` is required, the
   app refuses plain HTTP because the device token would travel in clear text.
3. **Pairing code**: the code you created with
   `POST /api/v1/pair {"action":"create"}` or the bot's `/pair`.
4. Press **Pair this phone**. The app redeems the code once and stores the device
   token. The token is never displayed again and cannot be recovered — re-pair if
   you lose it.

## 5. Enable the accessibility service

The app **cannot** enable it for you; Android requires a human to grant it.

```
Settings → Accessibility → NEXUS Phone Agent → On
```

What the service is allowed to do (declared in
`res/xml/accessibility_service_config.xml`):

* read the window content (`canRetrieveWindowContent`)
* perform gestures (`canPerformGestures`) — used only as a fallback for scrolling
* receive window-state, content-change, click and scroll events

It does **not** request key-event filtering or touch-exploration mode.

The dashboard shows the accessibility state as `enabled` or `disabled`, and a
task is refused with `ACCESSIBILITY_NOT_ENABLED` while it is off.

## 6. Verify it works

1. Dashboard shows **Connected** (not before `device_auth_ok`).
2. Accessibility shows **enabled**.
3. Type `Open YouTube` and press **Send task**.
4. The task screen shows step 1 of N, then `completed`.
5. Ask for something sensitive (`send a message to …`). The task parks in
   `awaiting_approval` with the reasons listed; **Approve** or **Deny** on the
   phone, or `/cancel` from the bot.
6. Press **Stop** mid-task: the remaining actions are cancelled and the phone
   reports `TASK_CANCELLED`.

If a step does not behave like that, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## 7. Settings on the phone

| Setting | Effect |
| --- | --- |
| Server address | HTTPS base URL. |
| WebSocket endpoint | Optional `wss://` override; derived automatically when empty. |
| Maximum actions per task | 1–30; the phone refuses a task that exceeds it. |
| Maximum task duration | 10–900 s; the phone stops a task that runs longer. |
| Keep task history | 1–365 days; older records are pruned. |
| Tap / Scroll / Type text / Read visible text | Per-capability kill switches enforced **on the phone**, independently of the server. |
| Share the list of installed apps | Off by default. When on, the launcher package list is sent at pairing time only. |

**Revoke local credentials** wipes the token, the task history and the pairing
state on the phone. It does not revoke the device on the server — do that with
`POST /api/v1/devices/:id/revoke` or the bot's `/revoke`.

## 8. Unit tests

The pure parts of the client — the redactor, the protocol and the on-device
policy rules — have JUnit tests under `android/app/src/test/java/`:

```bash
cd android && ./gradlew :app:testDebugUnitTest
```

They cover:

* `RedactorTest` — credentials, emails, long digit runs and secret field labels
  are recognised; ordinary text is left alone.
* `ProtocolTest` — malformed frames, wrong protocol versions and unknown types are
  rejected; every outbound message carries the fields the server's schema requires.
* `LocalPolicyTest` — the phone refuses unknown action types, bad package names,
  unknown settings screens, password/card fields, injected instructions,
  credential-shaped text, switched-off capabilities and over-budget sequences.

`org.json:json:20231013` is a **test-only** dependency: unit tests run against a
mockable `android.jar` whose `org.json` methods are stubbed out and return
defaults, so the real library is needed for them to behave. The app itself still
has zero runtime dependencies.

These tests have not been executed in the environment this repository was
produced in (no JDK or Android SDK was available there); they run in CI on the
first Gradle build. See the verification section in the README.

## 9. Static checks without the Android SDK

```bash
npm run android:check
```

This verifies, from the sources alone:

* every `R.<type>.<name>` used in Java exists in `res/`;
* every `R.id.*` exists in a layout;
* every class named in the manifest exists and no component is wrongly exported;
* no AndroidX, Kotlin or Compose dependency;
* no credential-looking value compiled into the app;
* the phone's allowlist is identical to the server's
  (`server/src/policies/actionSchema.js`);
* both sides declare the same `PROTOCOL_VERSION`.

It is not a compiler. It cannot prove the app builds — only Gradle can.

## 10. Battery and data

* One outbound TLS connection, kept alive with a heartbeat every 20 s.
* Exponential backoff when the server is unreachable, capped at 60 s.
* A persistent low-priority notification is required while the connection is up
  (Android foreground-service rules); it has a **Stop** action while a task runs.
* Task history lives in the app's private files directory; nothing is uploaded
  except action results and, when the server asks for it, a redacted screen
  summary.
