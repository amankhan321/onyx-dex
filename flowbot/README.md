# FlowBot — Telegram trading for Onyx on Arc

Button-driven trading (BONKbot-style UX) routed through **Onyx**, the hybrid
CLOB + StableSwap DEX on Arc.

## Security model — read this first

FlowBot is **self-custodial**, and the architecture is what makes that true
rather than a marketing line.

**The problem with the usual design.** In a plain Telegram bot, every keystroke
reaches the operator's server. If the user typed a password into the chat to
unlock a server-stored key, the operator would hold both the encrypted blob and
the password — able to decrypt any user's key at any time. That is custody,
whatever the marketing says, and a stolen server means stolen funds.

**What FlowBot does instead.** Anything that touches a key runs in a Telegram
**Mini App** — a webview on the user's own device:

| Server (bot) | Client (Mini App) |
| --- | --- |
| Menus, quotes, route preview | Mnemonic generation |
| Order tracking, fill alerts | Password entry |
| Referrals, settings, history | Keystore decryption |
| Stores: telegram_id, **encrypted blob**, settings | **Transaction signing** |

The server never receives a password, a mnemonic, or a plaintext key. It stores
an opaque blob it cannot open. The operator is therefore *technically* unable to
move user funds — not merely promising not to.

**Crypto choices** (`src/crypto/keystore.ts`, commented inline):

- **scrypt** N=2¹⁷, r=8, p=1 — memory-hard, so a leaked blob is expensive to
  attack. Audited `@noble/hashes` implementation, identical in browser and Node.
- **AES-256-GCM** via WebCrypto — authenticated, so a tampered blob fails loudly
  instead of decrypting to garbage we might sign with.
- Fresh 16-byte salt and 12-byte IV per encryption, never reused.
- The derived AES key is imported **non-extractable**.
- Decrypted keys live in memory only and are **zeroed** after signing
  (`withUnlocked()` does this even if the callback throws).
- Errors never carry key material; a failed unlock says only
  "wrong password or corrupted keystore".

**What the user is responsible for.** The recovery phrase is shown exactly once
and cannot be recovered by anyone — not by you, not by us. `/start` states this
plainly and requires explicit confirmation before the wallet is usable.

## Deposits

Cross-chain deposits use **Circle CCTP** only — native burn-and-mint USDC, no
custom bridge, no wrapped assets. Arc's CCTP domain is **26**; see the warning
in `.env.example` before touching that value.

## Structure

See `STRUCTURE.md` for the full layout and the trust boundary diagram.

## Setup

```bash
cp .env.example .env      # fill in TELEGRAM_BOT_TOKEN and MINIAPP_URL
npm install
npm run dev
```

Dependencies: `telegraf`, `viem`, `@noble/hashes`, `@scure/bip39`,
`@scure/bip32`, plus a DB driver for `DATABASE_URL`.

## Status

Implemented: architecture, trust boundary, keystore module.
Next: Onyx contract module (Router / OrderBook / Quoter / TwapExecutor), then
the Telegram UX layer.
