# Deploying FlowBot

> ## ⚠️ Testnet only
> FlowBot has not been audited, and the Arc network values in `.env.example` are
> unverified placeholders. Run this on Arc **testnet** with funds you are willing
> to lose. Do not point it at mainnet until every item in the pre-launch
> checklist at the bottom of this file is done.

## What runs where

FlowBot is two deployments, and the split is the whole security model:

| Piece | Where it runs | Holds keys? |
| --- | --- | --- |
| **Bot server** (`flowbot/`) | your host — VPS, Fly, Railway, a droplet | **No.** Cannot sign anything. |
| **Mini App** (`/miniapp`) | the Onyx Next.js app, already on Vercel | Yes — on the *user's* device |

The bot builds unsigned transactions and shows previews. Signing happens in the
Mini App, in a webview on the user's phone. A full compromise of the bot server
could show someone a misleading preview, but could not move their funds.

The Mini App needs no separate deployment: it is the `/miniapp` route in the app
you already ship. Set `MINIAPP_URL` to that route's public URL.

## 1. Environment

Copy the template and fill it in:

```bash
cd flowbot
cp .env.example .env
```

Every value marked **⚠️ UNVERIFIED** must be filled from
[docs.arc.network](https://docs.arc.network) — RPC URL, chain ID, token
addresses, and the Onyx contract addresses. Do not copy them from a blog post or
from memory.

Two values are already confirmed and can be left as-is:

- `ARC_EXPLORER=https://testnet.arcscan.app`
- `CCTP_ARC_DOMAIN=26` — verified against Circle's official docs. Domain **7 is
  Polygon PoS**; startup validation rejects it outright, because a wrong domain
  mints users' deposits on the wrong chain.

### Startup validation

The bot refuses to start on bad config and names exactly what's wrong:

```
✗ FlowBot will not start — configuration problems:

  • ARC_RPC_URL: missing, empty, or still a placeholder
  • ONYX_ROUTER: "0xdead" is not a valid 0x address
```

It also asks the RPC which chain it actually is and compares that to
`ARC_CHAIN_ID`. This catches the failure static checks cannot: a well-formed URL
pointing at the wrong network. That case doesn't error at runtime — it *succeeds*
on the wrong chain, which is exactly how funds end up somewhere nobody intended.

## 2. Register the bot with BotFather

1. Message [@BotFather](https://t.me/BotFather) → `/newbot`, pick a name and
   username. Put the token in `TELEGRAM_BOT_TOKEN`.
2. `/setmenubutton` → choose your bot → **Web App** → paste your `MINIAPP_URL`.
   This is what puts the signing surface one tap away.
3. `/setcommands` → paste:

   ```
   start - Set up or open your wallet
   referral - Your referral link
   ```

4. Optional but worth it: `/setdescription` and `/setabouttext`, both mentioning
   that this is self-custodial and the user holds their own keys.

**The Mini App URL must be HTTPS.** Telegram will silently refuse to open it
otherwise, which looks like a broken button rather than a config error.

## 3. Run it

```bash
cd flowbot
npm ci
npm run build
npm start
```

For development, `npm run dev` runs it under `tsx` with reload.

### The watcher

There is no separate watcher process. `startFillWatcher()` runs inside the bot
process on a 30-second timer and handles both jobs:

- **Fill alerts** — reads each tracked order's on-chain state rather than
  trusting the local record, so a fill that happened while the process was down
  is still caught on the next sweep. A cancelled order is distinguished from a
  filled one and never announced as a fill.
- **Price alerts** — compares the live curve price against user thresholds,
  fires once, then marks the alert triggered.

Both are idempotent, so restarting the bot is safe. If you later split the
watcher into its own process for scale, it needs the same `DATABASE_URL` and
read-only RPC access — nothing more.

### Process management

Any supervisor is fine. With pm2:

```bash
pm2 start dist/bot/index.js --name flowbot
pm2 save
```

The bot holds no keys, so its blast radius is limited — but it does hold the
Telegram token, so treat the host as production infrastructure.

## 4. Verify the deployment

1. `/start` in Telegram — the self-custody warning appears **before** any
   trading UI.
2. Tap **Set up wallet** — the Mini App opens and shows *"keys stay on this
   device"*. If you see the amber less-secure-storage banner on a current
   Telegram client, `SecureStorage` isn't available and something is wrong.
3. Create a wallet, save the phrase, confirm.
4. **Deposit** — send testnet USDC to the address shown.
5. **Buy** a small amount. The confirmation must show route split, price impact
   and slippage before the sign button appears.
6. Sign in the Mini App. You should get an Arcscan link back in the chat.

## Pre-launch checklist

Nothing below is optional before real funds are involved.

- [ ] **The six manual tests in `README.md`** ("Tests to run before real funds")
      all pass. Types cannot prove any of them: the vague wrong-password message,
      checksum rejection before the confirm screen, the whole-balance gas guard,
      show-once recovery phrase, loud fallback storage, and cancelled orders not
      being announced as fills.
- [ ] **Startup validation passes with real Arc values** — including the live
      chain-ID check, not just well-formed strings.
- [ ] **Rotate the GitHub token.** The PAT used to push this repo carries
      `workflow` scope, meaning anything holding it can execute arbitrary code in
      CI, and it has been reused across many sessions. Revoke and reissue.
- [ ] **Independent security review of the keystore and withdraw paths** before
      mainnet. Specifically: `web/lib/keystore.ts` (KDF parameters, IV/salt
      handling, key zeroing, that no error path leaks key material) and
      `flowbot/src/contracts/transfers.ts` (address checksum enforcement,
      balance and gas guards). I wrote both; neither has been reviewed by anyone
      else, and self-review is not review.
- [ ] **Arc network values verified** against docs.arc.network — RPC, chain ID,
      token and Onyx contract addresses.
- [ ] **CCTP addresses verified** against developers.circle.com. Domain 26 is
      confirmed; the contract addresses are not.
- [ ] Decide whether the **opt-in server keystore backup** is offered at all. It
      stays useless without the user's password, but it moves one factor into
      your custody — off by default for a reason.

## Known limitations

Stated plainly so they don't surprise you later:

- **No PnL.** Positions shows balances only. Real PnL needs a cost basis recorded
  from the first trade onward; anything shown today would be invented.
- **Referral fees are tracking-only.** Onyx's Router takes no referrer parameter,
  so a share cannot currently be paid out on-chain. `REFERRAL_FEE_BPS` defaults
  to 0 — don't advertise a cut that isn't paid.
- **Unaudited.** Including the crypto.
