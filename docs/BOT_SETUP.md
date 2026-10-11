# Bot setup

The bot is a thin front end. It authenticates the sender, then calls the same
task service the HTTP API uses, so every rule in `docs/SECURITY_MODEL.md`
applies to a task started from Telegram exactly as it does to one started with
`curl`.

Only one adapter is enabled at a time: the factory in `server/src/bot/index.js`
returns a disabled stub unless `TELEGRAM_ENABLED=true`. Today Telegram is the
only adapter that exists.

## 1. Create the bot

1. Open a chat with **@BotFather** in Telegram.
2. Send `/newbot` and follow the prompts (name, then a username ending in
   `bot`).
3. BotFather answers with the HTTP API token. That string is the bot's
   password — it goes in `.env` and nowhere else.

`@BotFather` can also rotate the token later (`/token`) or delete the bot
(`/deletebot`).

## 2. Configure

```bash
cp .env.example .env
```

```ini
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=123456:AA...           # from @BotFather
TELEGRAM_ALLOWED_USER_IDS=123456789       # your numeric user id
TELEGRAM_ALLOWED_CHAT_IDS=                # optional: also restrict the chat
TELEGRAM_POLL_TIMEOUT_SECONDS=25          # 1-50, long-poll window
TELEGRAM_API_BASE_URL=https://api.telegram.org
```

* `TELEGRAM_ALLOWED_USER_IDS` and `TELEGRAM_ALLOWED_CHAT_IDS` are comma or
  space separated lists of ids.
* At least one **user** id is required: the server refuses to boot with
  `TELEGRAM_ENABLED=true` and an empty allowlist.
* `TELEGRAM_ALLOWED_CHAT_IDS` is optional. Leave it empty to accept any chat
  from an allowed user; fill it in to pin the bot to specific chats or groups.
* `TELEGRAM_API_BASE_URL` only needs changing if you run a self-hosted Bot API
  server.

## 3. Find your numeric user id

Telegram does not show it in the app. The honest way is to let the server tell
you:

1. Set a placeholder allowlist, `TELEGRAM_ALLOWED_USER_IDS=0`, together with
   the token. The server refuses to boot with `TELEGRAM_ENABLED=true` and an
   empty allowlist, so it needs *something* there; `0` is not a real Telegram
   user id, which is exactly the point — everyone is unauthorized and every
   sender's id is logged.
2. Start the server (`npm start`) and send `/help` to your bot.
3. The server logs:

   ```
   bot.unauthorized_sender  {"userId":123456789,"chatId":123456789}
   ```

4. Put that `userId` in `TELEGRAM_ALLOWED_USER_IDS` (and the `chatId` in
   `TELEGRAM_ALLOWED_CHAT_IDS` if you want to pin the chat), replacing the `0`,
   then restart.

## 4. Run

```bash
npm start                 # node server/src/index.js
npm run dev               # the same, with --watch
LOG_FORMAT=pretty npm start   # human-readable logs while you set it up
```

The bot starts with the server; there is nothing else to launch and no webhook
or public URL to arrange — it uses long polling against
`getUpdates`. Useful log events:

| Event | Meaning |
| --- | --- |
| `bot.started` | Polling began; the payload counts the allowed users and chats. |
| `bot.unauthorized_sender` | Someone outside the allowlist wrote to the bot (with their ids). |
| `bot.poll_failed` | `getUpdates` failed; the loop retries after 5 s. |
| `bot.update_failed` | One update threw while being handled; polling continues. |
| `bot.send_failed` | A reply could not be delivered. |

`HTTP 409` from `getUpdates` means two processes are polling with the same
token — stop the other one.

## 5. Commands

| Command | What it does |
| --- | --- |
| `/help`, `/start` | The command list. |
| `/status` | Devices, and which of them are online. |
| `/devices` | Every paired device with its state and last-seen time. |
| `/pair` | Issues a single-use pairing code and its expiry. |
| `/run <task>` | Queues a task on the default device (the only usable one, or the online one). |
| `/task <id>` | Progress of one task. |
| `/cancel <id>` | Cancels one task. |
| `/stop` | Cancels every unfinished task. |
| `/revoke <device-id>` | Revokes a device credential. |

Anything that is not a command gets a short hint instead of being executed, so
a stray message can never start work on the phone.

## 6. What the bot is allowed to see

* Rate limit: **20 messages per minute per user**; beyond that the sender gets
  "Rate limit reached" and nothing is queued.
* `/pair` returns only the one-time code. The device token it is exchanged for
  never appears in a chat, a log, or a task payload.
* Replies are split at 3,900 characters, so long plans arrive as several
  messages.
* Notifications (`task.completed`, `task.failed`, `task.awaiting_approval`) go
  to the last chat that sent a command — that is the only "current chat" the bot
  remembers.
* The token lives in `.env`, which `.gitignore` excludes, and
  `npm run check:secrets` scans the tracked files for exactly this kind of
  string before every CI run.

## 7. WhatsApp and other adapters

Not implemented, on purpose. `server/src/bot/index.js` enables exactly one
adapter so that the one that ships is complete rather than several being half
finished. A WhatsApp adapter would mean an unofficial stack (Baileys or
similar): a reverse-engineered protocol that can break without notice, and a
dependency this repository does not add or verify. If you want one, add it as a
second class next to `TelegramBot`, keep the same `start`/`stop`/`status`/
`handleUpdate` shape, and wire it through the same factory.
