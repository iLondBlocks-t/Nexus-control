# Deploying NEXUS

Two supported paths: **Docker** (any host that runs containers) and **plain VPS**
(systemd + nginx). Both read every setting from `.env` on the server — nothing
is baked into the image or the repository.

## 0. Before anything else: your keys

Two secrets, both entered on the server only:

| Variable | Where to get it |
| --- | --- |
| `OWNER_API_TOKENS` | Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `OPENAI_API_KEY` | Your OpenRouter key (or any OpenAI-compatible provider) |

**Never paste either into a file that is committed.** This repository is public:
a key committed here is scraped and spent, usually within minutes, and rewriting
git history afterwards does not reliably get it out of every clone. That is also
why `npm run check:secrets` runs in CI and fails the build on anything shaped
like a key.

## 1. Docker

```bash
# on the server
git clone https://github.com/iLondBlocks-t/Nexus-control.git
cd Nexus-control
cp .env.example .env
nano .env                 # fill in the values below
docker compose up -d
docker compose logs -f    # Ctrl-C to stop following
```

Minimum `.env` for a hosted server:

```dotenv
NODE_ENV=production
PUBLIC_BASE_URL=https://nexus.example.com      # https, no trailing slash
OWNER_API_TOKENS=<the random string from above>

AI_PROVIDER=openai_compatible
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=<your OpenRouter key>
OPENAI_MODEL=<the exact model id from openrouter.ai/models>

STORAGE_DRIVER=json                            # json or sqlite
TELEGRAM_ENABLED=false                         # the control panel replaces it
```

Then:

```bash
curl https://nexus.example.com/healthz         # {"status":"ok",…}
# open https://nexus.example.com/console/ and paste OWNER_API_TOKENS
```

Updating later: `git pull && docker compose up -d --build`.

## 2. Plain VPS (no Docker)

```bash
sudo useradd -r -m -d /opt/nexus nexus
sudo mkdir -p /opt/nexus/app && sudo chown -R nexus:nexus /opt/nexus
sudo -u nexus git clone https://github.com/iLondBlocks-t/Nexus-control.git /opt/nexus/app
cd /opt/nexus/app && sudo -u nexus npm ci --omit=dev
sudo -u nexus cp .env.example .env && sudo -u nexus nano .env
sudo cp deploy/nexus.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nexus
sudo journalctl -u nexus -f
```

Then copy `deploy/nginx-nexus.conf`, replace `nexus.example.com` with your
domain, run Certbot, and reload nginx. TLS is not optional: the phone connects
over `wss://`, and the owner token travels in the `Authorization` header.

## 3. Point the phone at the server

`PUBLIC_BASE_URL` is what the server hands the phone during pairing, so it must
be the exact public URL, `https://`, no trailing slash. The device socket is
`wss://<host>/api/v1/device`; if you proxy it, keep the `Upgrade` headers (the
nginx snippet in this directory does).

In the app: **Setup** → server URL → **Pair** → take the code from the panel's
"New pairing code" button → enable the accessibility service.

## 4. What is verified and what is not

Verified here: `docker-compose.yml` parses, `npm run check:secrets` finds no
credential in any tracked file, the server boots and serves `/healthz` and
`/console/` (HTTP smoke test against a locally started process), and 146 server
tests plus the Android build pass in CI.

Not verified here: **the Docker image has never been built or run** — this
environment has no Docker. The `Dockerfile` follows the standard
`node:22-alpine` layout and the healthcheck is the same query `/healthz`
answers, but the first `docker compose up -d` on your machine is the real test.
If it fails, send me the output and I will fix it.

## 5. Other hosts

Render, Railway, Fly.io, Koyeb and similar all run this as a web service with
`node server/src/index.js`, port from `$PORT`, and the same environment
variables. Tell me which host you use and I will add its manifest file
(`render.yaml`, `fly.toml`, `Procfile`).
