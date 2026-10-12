# Deployment

NEXUS is a single Node.js process plus one Android APK. There is no database
server to run unless you choose the SQLite driver, and no inbound access to the
phone is required: the phone dials out.

## 1. What you need

| Item | Requirement |
| --- | --- |
| Host | Anything that can run Node.js 22.5+ with a public HTTPS endpoint |
| HTTPS | **Mandatory.** The device token must never travel in clear text |
| Storage | `json` (file, default), `sqlite`, or `memory` (ephemeral, tests only) |
| AI provider | An OpenAI API key and a model you have verified exists on your account |
| Port | One port; HTTP and WebSocket share it (`PORT`, default 3000) |

A reverse proxy (nginx, Caddy, Fly, Render, Cloudflare Tunnel) terminates TLS
and forwards to the Node process. Example nginx location:

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;   # longer than the heartbeat interval
}
```

`Upgrade` and `Connection` are what make the device socket work. A proxy that
drops them breaks the phone connection while HTTP keeps working — that is the
single most common deployment mistake. Set `TRUST_PROXY=true` when behind one.

## 2. Install

```bash
git clone https://github.com/iLondBlocks-t/Nexus-control.git
cd Nexus-control
npm ci --omit=dev
cp .env.example .env
$EDITOR .env
```

## 3. Configure

Minimum to be functional:

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
PUBLIC_BASE_URL=https://nexus.example.com
OWNER_API_TOKENS=<long random string>
AI_PROVIDER=openai
OPENAI_API_KEY=<your key>
OPENAI_MODEL=<a model available on your account>
STORAGE_DRIVER=json
```

Generate the owner token:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then verify the configuration before starting:

```bash
npm run check:config     # effective settings + warnings
npm run ai:doctor        # is the AI provider actually usable?
```

`npm run check:config` reports what it can validate offline (types, ranges,
hard ceilings, missing values). `npm run ai:doctor` reports `provider`, whether a
key is present and whether the provider is configured; it does **not** call the
provider.

### OpenRouter and other OpenAI-compatible providers

OpenRouter speaks the OpenAI HTTP API, so it needs no code — only
configuration. Pick the model on OpenRouter's site and copy its identifier
exactly:

```dotenv
AI_PROVIDER=openai_compatible
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=<your OpenRouter key>
OPENAI_MODEL=<the exact model id from openrouter.ai/models>
```

Keep the key on the server. It is never sent to the phone, it is never embedded
in the APK, and `npm run check:config` prints the settings with the key hidden.
If a key ever lands in a chat, a log or a commit, treat it as compromised and
rotate it at the provider before doing anything else.

### Model names

Do not guess a model. Model identifiers change and depend on your account.
`OPENAI_MODEL` is required when `AI_PROVIDER` is `openai`: check what your
account can call and put that exact identifier in `.env`. If the model is wrong,
tasks fail with `AI_PROVIDER_ERROR` or `INVALID_AI_PLAN` — the error message from
the provider is logged with the event `planner.*`.

### Every environment variable

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` forbids the mock AI provider. |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | Bind to `127.0.0.1` behind a proxy. |
| `PUBLIC_BASE_URL` | – | Used to build the `ws_url` given to the phone. |
| `WS_PATH` | `/api/v1/device` | Must match the reverse proxy path. |
| `TRUST_PROXY` | `true` | Set `false` if the process is directly exposed. |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | `pretty` for local development. |
| `OWNER_API_TOKENS` | – | Comma separated. Required for the API and the bot. |
| `MAX_MESSAGE_BYTES` | `32768` | Frame size limit. |
| `MAX_WS_CONNECTIONS` | `50` | Simultaneous device sockets. |
| `HEARTBEAT_INTERVAL_MS` | `20000` | Sent to the phone on auth. |
| `HEARTBEAT_TIMEOUT_MS` | `60000` | Dead-socket detection. |
| `AUTH_TIMEOUT_MS` | `15000` | Time allowed for `device_hello`. |
| `WS_MESSAGE_RATE_PER_MINUTE` | `240` | Per socket. |
| `PAIRING_CODE_TTL_SECONDS` | `300` | |
| `PAIRING_MAX_ATTEMPTS` | `5` | Failures before lockout. |
| `PAIRING_FAILURE_WINDOW_SECONDS` | `300` | |
| `PAIRING_CREATE_RATE_PER_MINUTE` | `10` | |
| `PAIRING_COMPLETE_RATE_PER_MINUTE` | `20` | Per IP. |
| `MAX_ACTIONS_PER_TASK` | `12` | Hard ceiling 30. |
| `MAX_TASK_DURATION_SECONDS` | `90` | Hard ceiling 900. |
| `MAX_ACTION_TIMEOUT_MS` | `20000` | Per action, on the wire. |
| `MAX_ACTION_RETRIES` | `2` | Per action. |
| `MAX_PLANNING_ITERATIONS` | `3` | Re-plans after a `read_visible_ui`. |
| `MAX_PENDING_TASKS_PER_DEVICE` | `3` | Hard ceiling 50. |
| `TASK_CREATE_RATE_PER_MINUTE` | `20` | Applies to API, bot and device. |
| `TASK_HISTORY_RETENTION_DAYS` | `30` | |
| `APPROVAL_TIMEOUT_SECONDS` | `900` | How long a task may wait. |
| `AI_PROVIDER` | `none` | `openai`, `openai_compatible`, `mock`, `none`. |
| `OPENAI_API_KEY` | – | Server side only. Never in the APK. |
| `OPENAI_MODEL` | – | Required for `openai`. Verify it on your account. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Change for a compatible gateway. |
| `OPENAI_REASONING_EFFORT` | – | `low`, `medium`, `high`, `xhigh`, `max`. |
| `AI_TIMEOUT_MS` | `45000` | |
| `AI_MAX_RETRIES` | `2` | |
| `POLICY_SENSITIVE_MODE` | `approval` | `approval` parks, `deny` refuses outright. |
| `STORAGE_DRIVER` | `json` | `json`, `sqlite`, `memory`. |
| `STORAGE_PATH` | – | Where the JSON/SQLite file lives. |
| `DATABASE_URL` | – | For the SQLite driver. |
| `TELEGRAM_ENABLED` | `false` | |
| `TELEGRAM_BOT_TOKEN` | – | From @BotFather. |
| `TELEGRAM_ALLOWED_USER_IDS` | – | **Required** when the bot is enabled. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | – | Optional extra restriction. |
| `TELEGRAM_POLL_TIMEOUT_SECONDS` | `25` | Long polling. |
| `TELEGRAM_API_BASE_URL` | `https://api.telegram.org` | |

## 4. Run

```bash
npm start          # production
npm run dev        # watch mode
```

Under systemd:

```ini
[Unit]
Description=NEXUS Phone Agent
After=network.target

[Service]
WorkingDirectory=/opt/nexus
ExecStart=/usr/bin/node server/src/index.js
Restart=always
RestartSec=5
EnvironmentFile=/opt/nexus/.env
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=/opt/nexus/data

[Install]
WantedBy=multi-user.target
```

## 4b. The control panel

The server ships a web panel at `/console/` — three static files
(`server/public/`), no build step and nothing loaded from a CDN:

```
http://127.0.0.1:3000/console/
```

Type the owner token from `.env` into the page; it is kept in that tab's session
storage and sent back to the same origin as a bearer token. The panel then
shows:

* the device list with online state, plus a **new pairing code** button;
* a task box — write an instruction, pick a device, run it;
* every task with its actions as they execute, refreshed while a task is
  running;
* **Approve / Deny / Cancel** buttons for a task that stopped for approval.

The panel is served without authentication on purpose: it holds no credentials
and cannot reach the data without the token. It is a thin client over
`/api/v1/*`, so it cannot widen any rule — the allowlist, the action budget and
the approval gate all live on the server. `curl` does the same thing if you
prefer a terminal.

## 4c. Hosting on a server

A ready-made kit lives in `deploy/`: `Dockerfile`, `docker-compose.yml`, a
systemd unit and an nginx reverse proxy, with the full walkthrough in
[deploy/README.md](../deploy/README.md). The short version:

```bash
cp .env.example .env && $EDITOR .env     # keys go here, never in git
docker compose up -d
curl https://nexus.example.com/healthz
```

Every setting comes from the environment. Nothing is baked into the image, and
`npm run check:secrets` scans the `Dockerfile` and the compose file too, so a
key pasted into either fails CI instead of reaching a registry.

## 5. Telegram bot

1. Create a bot with @BotFather and copy the token.
2. Get your numeric user id (send `/start` to a bot such as @userinfobot, or read
   `message.from.id` from `getUpdates`).
3. Set `TELEGRAM_ENABLED=true`, `TELEGRAM_BOT_TOKEN=…`, `TELEGRAM_ALLOWED_USER_IDS=…`.
4. Restart. The bot uses long polling: **no webhook, no public port needed**.
   If a webhook is set on the bot, `getUpdates` will not work — delete it with
   `https://api.telegram.org/bot<TOKEN>/deleteWebhook`.

## 6. Pair the phone

```bash
curl -X POST https://nexus.example.com/api/v1/pair \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"action":"create","label":"J7 Prime"}'
```

Enter the returned code in the app (or use the bot's `/pair`) within the TTL.
Then see [ANDROID_SETUP.md](./ANDROID_SETUP.md).

## 7. Backups

* `STORAGE_DRIVER=json` — back up `data/` (or `STORAGE_PATH`).
* `STORAGE_DRIVER=sqlite` — back up the database file while the process is
  stopped, or use the driver's own export.

Device tokens are stored hashed; a backup cannot be used to impersonate a phone,
but it does contain task history, so treat it as private.

## 8. Upgrading

```bash
git pull
npm ci --omit=dev
npm run check:config
npm run ai:doctor
# restart the process
```

Version 1 of the device protocol is used by both sides; a mismatch is reported
as `INVALID_PROTOCOL_VERSION` instead of silently misbehaving.
