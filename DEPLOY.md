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
