/**
 * Onyx keeper.
 *
 * Two jobs, one loop:
 *
 *  1. RATE. GuardedRateProvider halts the AMM if no rate lands within its
 *     6-hour staleness window — that is a deliberate safety property, and this
 *     process is the operational half of it. Every cycle it reads the live
 *     ECB EUR/USD rate and pushes an update when (a) the market has moved
 *     meaningfully, or (b) the last update is aging toward staleness. The
 *     contract enforces its own guardrails (1% max step, 5-minute cooldown),
 *     so a bug here can annoy the pool but cannot break it.
 *
 *  2. TWAP. Scans open TWAPs and cranks any slice that is due. Cranking is
 *     permissionless and pays KEEPER_FEE_BPS; the owner's per-slice price
 *     floor is enforced on-chain, so the worst this can do is revert.
 */
import { ethers } from "ethers";

const RPC = process.env.RPC_URL ?? "https://rpc.testnet.arc.network";
const PK = process.env.PRIVATE_KEY;
if (!PK) {
  console.error("PRIVATE_KEY is required (the rate-updater key)");
  process.exit(1);
}

const RATE_PROVIDER = process.env.RATE_PROVIDER ?? "0x5BD82828Ffd74d7d9df5B0266d8F8Dc6f05f6d74";
const TWAP = process.env.TWAP ?? "0x1081ea6642F8f67dc1ff8A40b8A60900c0180dBE";

const LOOP_MS = 60_000;
// Refresh well inside the 6h staleness window.
const HEARTBEAT_S = 4 * 3600;
// Also push if market moved > 0.2% from on-chain.
const DRIFT = 0.002;
const MAX_TICK = 1_048_575;

const rpAbi = [
  "function rate() view returns (uint256)",
  "function updatedAt() view returns (uint256)",
  "function setRate(uint256)",
  "function MIN_UPDATE_INTERVAL() view returns (uint256)",
];
const twapAbi = [
  "function nextTwapId() view returns (uint256)",
  "function twaps(uint256) view returns (address owner, bool zeroForOne, bool active, uint32 interval, uint32 slicesLeft, uint128 sliceAmount, uint128 remaining, uint64 nextExecAt, uint192 minPriceX18)",
  "function crank(uint256 id, uint256 bookAmountIn, uint32 limitTick, uint16 maxOrders) returns (uint256)",
];

// staticNetwork avoids a chain-id round-trip on every call; the retry wrapper
// below is what actually survives a flaky endpoint (the "missing revert data"
// was a dropped read with no retry, not a bad ABI).
// batchMaxCount: 1 forces one eth_call per request. This RPC intermittently
// drops BATCHED calls (ethers bundles Promise.all reads into a single JSON-RPC
// batch), which ethers reports as the maximally-unhelpful "missing revert
// data". One call per request is a hair chattier and actually works.
const provider = new ethers.JsonRpcProvider(RPC, undefined, {
  staticNetwork: true,
  batchMaxCount: 1,
});

async function withRetry(label, fn, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`${label}: ${lastErr?.shortMessage ?? lastErr?.message ?? lastErr}`);
}
const wallet = new ethers.Wallet(PK, provider);
const rp = new ethers.Contract(RATE_PROVIDER, rpAbi, wallet);
const twap = new ethers.Contract(TWAP, twapAbi, wallet);

let lastFx = { value: 1.08, at: 0 };

/** ECB reference rate via frankfurter.app — free, keyless, cached 10 min. */
async function eurUsd() {
  if (Date.now() - lastFx.at < 10 * 60_000) return lastFx.value;
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=EUR&to=USD");
    const j = await r.json();
    const v = Number(j?.rates?.USD);
    if (v > 0.5 && v < 2) lastFx = { value: v, at: Date.now() };
  } catch (e) {
    console.warn("fx fetch failed, using last known:", e.message);
  }
  return lastFx.value;
}

async function tendRate() {
  const cur = await withRetry("rate()", () => rp.rate());
  const at = await withRetry("updatedAt()", () => rp.updatedAt());
  const now = Math.floor(Date.now() / 1000);
  const age = now - Number(at);
  const MIN_GAP = 5 * 60; // MIN_UPDATE_INTERVAL is a compile-time constant
  if (age < MIN_GAP) return; // contract cooldown; nothing to do yet

  const market = await eurUsd();
  const target = BigInt(Math.round(market * 1e6)) * 10n ** 12n;

  const curF = Number(cur) / 1e18;
  const drifted = Math.abs(market - curF) / curF > DRIFT;
  const aging = age > HEARTBEAT_S;
  if (!drifted && !aging) return;

  // Contract caps each step at 1%. Clamp so we never revert; if the market is
  // further than 1% away we converge over successive cycles.
  const maxStep = cur / 100n;
  let next = target;
  if (next > cur + maxStep) next = cur + maxStep;
  if (next < cur - maxStep) next = cur - maxStep;
  // THE 6H-FREEZE BUG: after converging exactly to market, next === cur and we
  // skipped the write forever — so updatedAt never refreshed and the oracle
  // went stale by design. On heartbeat we MUST write even an unchanged value:
  // a same-value setRate passes the deviation check and refreshes the clock.
  if (next === cur && !aging) return;

  console.log(
    `rate: ${curF.toFixed(6)} -> ${(Number(next) / 1e18).toFixed(6)} ` +
    `(market ${market.toFixed(6)}, age ${(age / 3600).toFixed(1)}h, ${drifted ? "drift" : "heartbeat"})`,
  );
  const tx = await rp.setRate(next);
  await tx.wait();
  console.log(`  setRate mined: ${tx.hash}`);
}

async function crankTwaps() {
  const n = Number(await withRetry("read nextTwapId", () => twap.nextTwapId()));
  const now = Math.floor(Date.now() / 1000);

  for (let id = 1; id < n; id++) {
    let t;
    try {
      t = await twap.twaps(id);
    } catch {
      continue;
    }
    if (!t.active || now < Number(t.nextExecAt)) continue;

    // bookAmountIn 0 => AMM route; owner's minPriceX18 still protects the fill.
    const limitTick = t.zeroForOne ? 1 : MAX_TICK;
    try {
      const tx = await twap.crank(id, 0n, limitTick, 30);
      await tx.wait();
      console.log(`twap #${id}: slice cranked, ${tx.hash}`);
    } catch (e) {
      // Owner's price floor not met, or raced by another keeper. Both fine.
      console.log(`twap #${id}: crank declined (${e.shortMessage ?? e.message})`);
    }
  }
}

console.log(`onyx-keeper up. updater=${wallet.address} rp=${RATE_PROVIDER}`);
for (;;) {
  try {
    await tendRate();
    await crankTwaps();
  } catch (e) {
    console.error("loop error:", e.message ?? e);
  }
  await new Promise((r) => setTimeout(r, LOOP_MS));
}
