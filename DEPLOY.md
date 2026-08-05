# Deploying Onyx

Two targets. They serve different purposes and both are supported.

## Vercel (recommended for the frontend)

The frontend is a static Next.js app that talks straight to the Arc RPC from the
browser. No server, no database, no secrets. A CDN is the right shape for that.

1. Import `amankhan321/arc-dex` at vercel.com/new
2. **Root Directory → `web`** (the repo root is a Foundry project, not a Next app)
3. Framework preset → Next.js
4. Deploy

Auto-redeploys on every push to `main`. No env vars needed — contract addresses
are compiled in.

## DigitalOcean droplet

Useful when you want the whole thing on infrastructure you control, and it's the
same box that will later run the TWAP keeper.

```bash
# on a fresh Ubuntu 24.04 droplet
apt update && apt install -y docker.io docker-compose-plugin git
git clone https://github.com/amankhan321/arc-dex.git
cd arc-dex

# with a domain (Caddy fetches a TLS cert automatically on first boot)
export SITE_ADDRESS=onyx.yourdomain.com
docker compose up -d --build

# no domain yet? Caddy falls back to plain HTTP on :80
docker compose up -d --build
```

Check it:

```bash
docker compose ps
docker compose logs -f web
```

The image is built from `web/Dockerfile` as a multi-stage build against Next's
`standalone` output, so the runtime layer ships only the dependencies actually
imported — roughly 150MB instead of 600MB. It runs as a non-root user and has a
healthcheck, because a public-facing web server should not be root and should be
able to tell you it's alive.

**Point DNS first.** An A record for your domain to the droplet's IP, then bring
the stack up. Caddy needs the domain to resolve before it can complete the
ACME challenge.

### Updating

```bash
git pull && docker compose up -d --build
```

## Contracts

Already deployed and verified on Arc Testnet — see the addresses in `README.md`.
Redeploying is only necessary if the contracts change:

```bash
export PRIVATE_KEY=0x...
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY --broadcast --skip-simulation -vvv
```

`--skip-simulation` is required: Foundry simulates in a local EVM fork that has
no knowledge of Arc's token contracts.

## Telegram bot and Mini App

Two manual steps that no amount of code can do for you, because both live in
BotFather and neither is exposed over the Bot API.

### 1. Register the Mini App (required for chat-initiated trades)

A trade started in chat produces a deep link carrying an opaque intent id, which
Telegram delivers to the app as `start_param`. That link only resolves if the
Mini App is registered — otherwise the tap dead-ends with **"Bot application not
found"**.

Pick one of the two forms. `MINIAPP_SHORT_NAME` selects which link the bot
builds (see `web/lib/bot/cards.ts` → `deepLink`).

**Named app** — the default, `MINIAPP_SHORT_NAME=app`:

1. BotFather → `/myapps` → **Create New App**, select `@OnyxArcBot`
2. Short name: **`app`** — must match `MINIAPP_SHORT_NAME` exactly
3. Web App URL: `https://onyx-dex.vercel.app/miniapp`
4. Supply the title, description and icon it asks for

Produces `t.me/OnyxArcBot/app?startapp=<id>`.

**Main Mini App** — set `MINIAPP_SHORT_NAME=` (empty):

1. BotFather → `/mybots` → `@OnyxArcBot` → **Bot Settings → Configure Mini App**
2. Set the Mini App URL to `https://onyx-dex.vercel.app/miniapp`

Produces `t.me/OnyxArcBot?startapp=<id>`. No short name exists to misspell, so
this is the more forgiving option.

Either way the id is base64url, which satisfies Telegram's `startapp` charset
(`A-Z a-z 0-9 _ -`) and its 512-character limit.

### 2. Register the webhook and the command menu

Run the **"Register Telegram webhook"** Action (`workflow_dispatch`). It POSTs
`/api/telegram/setup` with the admin secret, which calls `ensureSchema()`,
`setWebhook()` and `setMyCommands()` server-side — so the bot token never leaves
Vercel's environment. Re-run it whenever the deployment URL changes.

After it runs, the `/` menu appears in Telegram and the `trade_intents` table
exists, which is what `/buy` needs.

### Environment variables

Set on Vercel (not compiled in, unlike the contract addresses):

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot API calls. Never sent to a browser. |
| `TELEGRAM_WEBHOOK_SECRET` | Stamped on inbound webhooks by Telegram, checked on arrival. |
| `TELEGRAM_ADMIN_SECRET` | Guards `/api/telegram/setup`. Also a GitHub repo secret. |
| `TELEGRAM_ADMIN_CHAT_ID` | Where keeper alerts go. **Unset means a stale feed alerts nobody.** |
| `DATABASE_URL` | Neon Postgres. |
| `PUBLIC_BASE_URL` | Builds the webhook URL. Must be the production URL. |
| `MINIAPP_SHORT_NAME` | Deep-link form. `app` for a named app, empty for Main Mini App. |
| `MINIAPP_URL` | Where the bot's own buttons open. Defaults to the Vercel URL. |

There is no signing key here, and none may be added. The server reads chain
state and stores intents; it cannot sign, and every write is signed on the
user's device.
