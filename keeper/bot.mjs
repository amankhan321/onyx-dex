/**
 * Onyx trading bot — MODE 2, OWNER / TESTING ONLY.
 *
 * ============================ READ THIS FIRST ============================
 * This worker trades autonomously from ITS OWN dedicated wallet (PRIVATE_KEY),
 * with no per-action confirmation. It exists so the project owner can seed and
 * exercise the book on testnet.
 *
 * It is deliberately NOT wired into the public UI, and no end-user flow in this
 * repo ever asks anyone for a private key. Users get the client-side bot
 * (web/components/BotPanel.tsx), which signs with their own wallet. If you are
 * tempted to expose this worker to users, don't: it would mean holding their
 * keys, which is custody, and this project does not do that.
 *
 * Fund the bot wallet with only what you are willing to lose on testnet.
 * =========================================================================
 *
 * Strategies (same primitives as the client bot):
 *   mm   — post-only maker quotes either side of mid on OrderBook
 *   grid — Router swaps when price leaves a band around the reference
 *   dca  — fixed-size Router swap each cycle
 *
 * Every Router swap is sized by the Quoter's optimal book/AMM split, so the
 * bot uses the same routing path as the app.
 */
import { ethers } from "ethers";

const RPC = process.env.RPC_URL ?? "https://rpc.testnet.arc.network";
const PK = process.env.PRIVATE_KEY;
if (!PK) {
  console.error("[bot] PRIVATE_KEY is required — this must be a DEDICATED bot wallet, not a personal one");
  process.exit(1);
}

// Addresses come from env with the deployed defaults, mirroring keeper/index.mjs.
const BOOK = process.env.BOOK ?? "0x6E04B607Fe10F2A6005d9A843A866129b7274810";
const ROUTER = process.env.ROUTER ?? "0x52F9Df11DAE5Af839c28216e2d4f8ab678219312";
const QUOTER = process.env.QUOTER ?? "0xf2346e79Ab9D92c5e6B5D949331F186a5e040461";
const POOL = process.env.POOL ?? "0x3Bf8E6EfF4850D8172c019CeEeA00787928162De";
const USDC = process.env.USDC ?? "0x3600000000000000000000000000000000000000";
const EURC = process.env.EURC ?? "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

const STRATEGY = (process.env.BOT_STRATEGY ?? "mm").toLowerCase(); // mm | grid | dca
const SIZE = Number(process.env.BOT_SIZE ?? "1"); // per action, in USDC units
const SPREAD_BPS = Number(process.env.BOT_SPREAD_BPS ?? "40");
const MAX_CAPITAL = Number(process.env.BOT_MAX_CAPITAL ?? "10"); // hard session cap
const LOOP_MS = Number(process.env.BOT_LOOP_MS ?? "60000");
const DCA_SELL_USDC = (process.env.BOT_DCA_SELL ?? "true") === "true";
// Safety: dry-run unless explicitly armed. Nothing is signed until BOT_ARMED=true.
const ARMED = process.env.BOT_ARMED === "true";

const DEC = 6n;
const ONE = 10n ** DEC;
const TICK_SIZE = 1e-5;
const toUnits = (n) => BigInt(Math.floor(n * Number(ONE)));
const fromUnits = (v) => Number(v) / Number(ONE);
const tickOf = (price) => Math.round(price / TICK_SIZE);

const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const bookAbi = [
  "function bestBid() view returns (uint32)",
  "function bestAsk() view returns (uint32)",
  "function placeOrder(bool,uint32,uint128) returns (uint64)",
  "function cancelOrder(uint64)",
  "function claim() returns (uint256,uint256)",
];
const quoterAbi = [
  "function quote(bool,uint256,uint16) view returns (tuple(uint256 bookIn,uint256 ammIn,uint256 expectedOut,uint256 bookOut,uint256 ammOut,uint32 limitTick))",
];
const routerAbi = [
  "function swapExactIn(bool,uint256,uint256,uint256,uint32,uint16,uint256,address) returns (uint256)",
];
const poolAbi = ["function getDy(bool,uint256) view returns (uint256)"];

// batch:false equivalent — Arc's RPC drops batched eth_calls, so keep the
// provider on single requests (same lesson as the frontend transport).
const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const wallet = new ethers.Wallet(PK, provider);

const book = new ethers.Contract(BOOK, bookAbi, wallet);
const router = new ethers.Contract(ROUTER, routerAbi, wallet);
const quoter = new ethers.Contract(QUOTER, quoterAbi, provider);
const pool = new ethers.Contract(POOL, poolAbi, provider);
const usdc = new ethers.Contract(USDC, erc20Abi, wallet);
const eurc = new ethers.Contract(EURC, erc20Abi, wallet);

let deployed = 0; // capital committed since start
let consecutiveErrors = 0;
let stopped = false;

const log = (...a) => console.log(new Date().toISOString(), "[bot]", ...a);

async function ensureAllowance(token, spender, amount) {
  const owner = await wallet.getAddress();
  const current = await token.allowance(owner, spender);
  if (current >= amount) return;
  log("approving", spender);
  const tx = await token.approve(spender, amount * 20n);
  await tx.wait();
}

/** Current AMM price (EURC per USDC) from a 1-unit quote. */
async function curvePrice() {
  const dy = await pool.getDy(true, ONE);
  return fromUnits(dy);
}

async function routerSwap(zeroForOne, amountIn) {
  const q = await quoter.quote(zeroForOne, amountIn, 16);
  if (q.expectedOut === 0n) {
    log("quoter returned 0 — skipping");
    return;
  }
  if (!ARMED) {
    log(`DRY-RUN swap ${zeroForOne ? "USDC→EURC" : "EURC→USDC"} ${fromUnits(amountIn)} → ${fromUnits(q.expectedOut)}`);
    return;
  }
  await ensureAllowance(zeroForOne ? usdc : eurc, ROUTER, amountIn);
  const minOut = (q.expectedOut * 995n) / 1000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const tx = await router.swapExactIn(
    zeroForOne, amountIn, q.bookIn, minOut, q.limitTick, 30, deadline, await wallet.getAddress(),
  );
  const rc = await tx.wait();
  log(`swap ${zeroForOne ? "USDC→EURC" : "EURC→USDC"} ${fromUnits(amountIn)} · ${rc.hash}`);
}

/** Post-only quote, clamped so it cannot cross (the contract would revert). */
async function postQuote(isBid, price, baseAmount) {
  const [bb, ba] = [Number(await book.bestBid()), Number(await book.bestAsk())];
  let p = price;
  if (isBid && ba !== 0) p = Math.min(p, ba * TICK_SIZE - TICK_SIZE);
  if (!isBid && bb !== 0) p = Math.max(p, bb * TICK_SIZE + TICK_SIZE);
  if (p <= 0) return;

  if (!ARMED) {
    log(`DRY-RUN ${isBid ? "bid" : "ask"} ${fromUnits(baseAmount)} @ ${p.toFixed(5)}`);
    return;
  }
  const escrow = isBid ? BigInt(Math.ceil(p * Number(baseAmount))) : baseAmount;
  await ensureAllowance(isBid ? eurc : usdc, BOOK, escrow);
  const tx = await book.placeOrder(isBid, tickOf(p), baseAmount);
  const rc = await tx.wait();
  log(`${isBid ? "bid" : "ask"} ${fromUnits(baseAmount)} @ ${p.toFixed(5)} · ${rc.hash}`);
}

let alternate = true;

async function cycle() {
  if (stopped) return;
  if (deployed + SIZE > MAX_CAPITAL) {
    log(`max capital ${MAX_CAPITAL} reached — idling`);
    return;
  }

  const px = await curvePrice();
  const amount = toUnits(SIZE);

  if (STRATEGY === "mm") {
    const half = (SPREAD_BPS / 10_000) * px * 0.5;
    await postQuote(alternate, alternate ? px - half : px + half, amount);
    alternate = !alternate;
  } else if (STRATEGY === "grid") {
    const band = (SPREAD_BPS / 10_000) * px;
    const ref = Number(process.env.BOT_GRID_REF ?? px);
    if (px < ref - band) await routerSwap(true, amount);
    else if (px > ref + band) await routerSwap(false, amount);
    else {
      log(`price ${px.toFixed(5)} inside band — no action`);
      return;
    }
  } else {
    await routerSwap(DCA_SELL_USDC, amount);
  }
  deployed += SIZE;
}

async function main() {
  const addr = await wallet.getAddress();
  log(`wallet ${addr}`);
  log(`strategy=${STRATEGY} size=${SIZE} spread=${SPREAD_BPS}bps cap=${MAX_CAPITAL} loop=${LOOP_MS}ms`);
  if (!ARMED) log("DRY-RUN mode — set BOT_ARMED=true to sign real transactions");

  for (;;) {
    try {
      await cycle();
      consecutiveErrors = 0;
    } catch (e) {
      log("error:", String(e?.shortMessage ?? e?.message ?? e).slice(0, 160));
      if (++consecutiveErrors >= 5) {
        log("5 consecutive errors — stopping for safety");
        stopped = true;
        process.exit(1);
      }
    }
    await new Promise((r) => setTimeout(r, LOOP_MS));
  }
}

process.on("SIGINT", () => {
  log("shutting down");
  process.exit(0);
});

main().catch((e) => {
  log("fatal:", e);
  process.exit(1);
});
