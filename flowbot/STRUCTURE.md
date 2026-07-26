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

## What the server may never do

- receive, log, or persist a password, mnemonic, or plaintext key
- include key material in error messages or telemetry
- construct a transaction that a user did not explicitly confirm
