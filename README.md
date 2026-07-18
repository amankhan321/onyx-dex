# Onyx

**The first on-chain central limit order book on Arc.** Hybrid CLOB + rate-adjusted StableSwap AMM for stablecoin FX.

Every other DEX on Arc is a Curve fork. This isn't.

---

## Why a CLOB, and why only on Arc

AMMs exist because on-chain order books are impossible on Ethereum — gas is too expensive and blocks are too slow to place, cancel, and match orders at market speed.

Arc removes both constraints:

- **Sub-second deterministic finality** (Malachite consensus) — a maker can quote and pull without being picked off across a 12-second block.
- **Flat ~$0.01 gas, denominated in USDC** — placing and cancelling orders costs a rounding error, so real market-making is economic.

Circle is explicitly building Arc for **FX and capital markets**. Institutions doing FX do not want AMM slippage; they want limit orders, price-time priority, and TWAP. Onyx gives them a book, and keeps an AMM underneath as backstop depth.

The order book is a primitive that is **only viable on Arc**. That's the whole thesis.

---

## The bug in everyone else's pool

Every Arc DEX runs a Curve 1:1 StableSwap invariant on **USDC/EURC**.

EURC is euro-pegged. It trades around **1.08-1.16 USD**, not 1.00. The StableSwap invariant *assumes the coins trade at par* — that assumption is baked into the maths. Feed it a genuine FX pair and the curve concentrates liquidity around a peg that does not exist, and arbitrageurs drain it toward par.

Onyx uses a **rate-adjusted** invariant: coin1 is converted into coin0 terms through an immutable rate provider *before* it ever touches the curve, so the 1:1 assumption is actually true. There is a test that asserts we do not quote near 1:1 on a 1.08 pair (`test_NaivePegWouldBeDrained`).

---

## Architecture

| Contract | Role |
|---|---|
| `StableSwap.sol` | Rate-adjusted 2-coin StableSwap. LP token. Backstop liquidity. |
| `OrderBook.sol` | On-chain CLOB. Post-only makers, price-time priority, tick bitmap. |
| `Router.sol` | Sweeps the book, routes the remainder to the AMM, one slippage bound over both. |
| `Quoter.sol` | View-only. Finds the optimal book/AMM split by ternary search. |
| `TwapExecutor.sol` | Slices large FX orders over time. Permissionless keeper cranking. |
| `RateProvider.sol` | `Par` (1:1) and `Guarded` (pushed FX rate, hard guardrails). |
| `libraries/StableMath.sol` | Curve invariant — `getD` / `getY` via Newton's method. |
| `libraries/TickBitmap.sol` | Uniswap-V3-style bitmap for best-bid/best-ask discovery. |

**Fee flow:** the book's taker fees are not skimmed by a treasury. They accrue to `pendingFee*`, and anyone can call `flushFees()`, which donates them into the StableSwap pool and raises its virtual price. **The book pays the pool that backstops it.**

---

## Security posture

Read this part.

### What we actually did

- **No admin. Anywhere.** No owner, no pauser, no upgrade path, no fee switch, no rescue function, no proxy. Every parameter is `immutable`, set at deploy. There is no key that can move user funds — including ours.
- **Pull payments in the matching loop.** Fills credit an internal `claimable` balance; makers withdraw separately. The matching loop contains **zero external calls**, so reentrancy against it is not merely guarded, it is structurally impossible.
- **Post-only makers.** An order that would cross the spread reverts. Maker and taker code paths never interleave.
- Checks-effects-interactions throughout. `ReentrancyGuard` on every state-mutating external. Solidity 0.8.24, no `delegatecall`, no upgradeable proxies.
- Internal balance accounting — `balanceOf()` is never trusted, so direct transfers into the pool cannot skew pricing.
- Proportional-only LP exit. No `removeLiquidityOneCoin`; imbalanced exit is where StableSwap forks historically get drained, and we do not need it.
- LPs can always exit **even if the oracle is stale and every other function is halted**.
- Slippage floors and deadlines on every taker path.

### Tests: 34 passing

- 30 unit + fuzz (512 runs each on three properties)
- 4 **invariants**, run over **32,768 randomized state transitions**:
  - `invariant_BookIsSolvent` — the book always holds enough tokens to cover every maker claim, every resting escrow, and every unflushed fee. *If this can break, someone's money is gone.*
  - `invariant_PoolVirtualPriceNeverDecreases` — LP share value can never leak.
  - `invariant_BookNeverCrossed` — post-only can never be defeated.
  - `invariant_RouterHoldsNothing` — the router never rests on user funds.

### What we did NOT do, and you should not pretend otherwise

**This is not audited.** Nobody can promise "no vulnerabilities," and anyone who tells you they can is selling something. The above gets us to *defensible and testnet-safe*, not *safe with real money*.

The single trusted component is the `GuardedRateProvider` updater. A compromised updater cannot instantly drain the pool — it is fenced by a 1%-per-update deviation cap, a 5-minute cooldown, and a 6-hour staleness window that **halts the AMM rather than pricing off a dead feed** — but it is a trust assumption and it is disclosed. Replace it with a Chainlink adapter the moment an EUR/USD feed lands on Arc.

This lives on **testnet, with test USDC**. If it ever touches real money, it gets audited first. Non-negotiable.

---

## Deploy to Arc Testnet

Arc Testnet — chain `5042002` · RPC `https://rpc.testnet.arc.network` · explorer `https://testnet.arcscan.app`

```bash
# 1. install
curl -L https://foundry.paradigm.xyz | bash && foundryup
forge install

# 2. test
forge test -vv

# 3. deploy
export PRIVATE_KEY=0x...
forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.testnet.arc.network \
  --private-key $PRIVATE_KEY \
  --broadcast -vvv
```

Gas is paid in USDC. Get testnet USDC and EURC from `faucet.circle.com` (select Arc Testnet).

**After deploy, seed liquidity at rate-parity** — for a 1.08 EUR/USD rate that means roughly 1080 USDC to every 1000 EURC. Depositing 1:1 into a rate-adjusted pool just hands free money to the first arbitrageur.

---

## Roadmap

- [x] Contracts + full test suite (34 passing)
- [ ] Deploy to Arc Testnet, seed liquidity
- [ ] Next.js + wagmi frontend (dark, motion-heavy) -> Vercel
- [ ] Indexer + order-book mirror + TWAP keeper (Postgres + Node) -> DigitalOcean
- [ ] Submit to Arc House: Stablecoins Commerce Stack Challenge
