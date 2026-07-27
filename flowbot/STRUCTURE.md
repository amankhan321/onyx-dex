# FlowBot — architecture

## Trust boundary (the whole design rests on this)

    ┌─────────────── USER'S DEVICE ───────────────┐
    │  Telegram Mini App (webview, our origin)     │
    │   • mnemonic generated here                  │
    │   • password entered here, never transmitted │
    │   • keystore decrypted here, in memory       │
    │   • transaction SIGNED here                  │
    │   • sends: signed raw tx  ─────────────┐     │
    └────────────────────────────────────────┼─────┘
                                             │
    ┌─────────────── OUR SERVER ─────────────┼─────┐
    │  Telegram bot (Telegraf)               ▼     │
    │   • menus, quotes, route preview             │
    │   • broadcasts signed tx / or client does    │
    │   • fill notifications, referrals, history   │
    │   • STORES: telegram_id, ENCRYPTED blob,     │
    │     settings, order history                  │
    │   • NEVER receives: password, mnemonic,      │
    │     plaintext key                            │
    └──────────────────────────────────────────────┘

The operator cannot decrypt a user's keystore because the operator never
receives the password. That is the property that makes the self-custody claim
true rather than marketing.

## Folders

    src/
      config/        env loading + Arc network config (chain id, RPC, addresses)
      crypto/        keystore: KDF, AES-GCM, mnemonic. ISOMORPHIC — the same
                     module runs in the Mini App; the server only ever handles
                     the opaque blob.
      contracts/     Onyx ABIs + typed wrappers (Router, OrderBook, Quoter,
                     TwapExecutor, StableSwap) and CCTP for deposits
      services/      quoting, routing, order tracking, notifications, referrals
      db/            schema + queries. Stores NO key material.
      bot/
        handlers/    one file per menu: start, buy, sell, positions, limit,
                     twap, deposit, withdraw, settings, help
    miniapp/         the signing surface (can live as a route in the Onyx
                     Next.js app instead — recommended, it already has viem)

## Flow of a trade

1. User taps Buy → 100 in the bot.
2. Server quotes via Onyx Quoter, shows route split (book vs StableSwap),
   price impact, fee. No key involved.
3. User taps Confirm → bot opens the Mini App with the unsigned tx payload.
4. Mini App asks for the password, decrypts in memory, signs, wipes.
5. Signed tx broadcast; hash returned to the chat with an Arcscan link.

## Where the keystore lives (Bot API 9.0 `SecureStorage`)

Primary store is the **user's own device**, via Telegram's `SecureStorage` —
introduced in Bot API 9.0 for exactly this purpose. The encrypted blob never
needs to reach us at all.

    SecureStorage  → encrypted keystore blob (device-local, primary)
    DeviceStorage  → non-sensitive prefs: last amounts, slippage, cached quotes
    Our server     → telegram_id, settings, order history. No key material.

### Optional server backup — the tradeoff, stated plainly

A user who loses their phone loses a device-local blob. We may offer an opt-in
backup copy on the server. What that does and doesn't change:

* The blob remains **useless without the password**, which never leaves the
  device. A breach of our database yields scrypt-hardened ciphertext, not funds.
* But it moves one factor into our custody. A user with a weak password is
  meaningfully worse off if our DB leaks than if the blob had stayed on-device.
* So: **opt-in, off by default**, with that sentence shown at the moment of
  choosing — not buried in a policy page.
* Even with a backup, we still cannot decrypt it. The password is the thing we
  never have, and that property is what the whole design protects.

The recovery phrase remains the real backup, shown once at creation.

## `initData` — identity only, never key access

The Mini App receives Telegram's signed `initData`; the server verifies it by
HMAC with the bot token to establish *which telegram_id this session is*.

That authenticates identity and nothing more. It must never gate, unlock, or
authorise access to key material — keys are device-local and password-locked, so
a forged or replayed session still cannot move funds. Identity is for menus,
history and notifications; custody is for the device.

## What the server may never do

- receive, log, or persist a password, mnemonic, or plaintext key
- include key material in error messages or telemetry
- construct a transaction that a user did not explicitly confirm
