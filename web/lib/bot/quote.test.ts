import { test } from "node:test";
import assert from "node:assert/strict";
import {
  quoteSwap,
  blendedFeeBps,
  renderQuote,
  renderPrice,
  describeSwap,
  refusalMessage,
  formatUnits6,
  PAIR,
  type Reads,
  type OracleStatus,
  type RouteQuote,
  type FeeParams,
  type BookStatus,
} from "./quote";

const STALENESS_WINDOW = 21_600;

function freshOracle(over: Partial<OracleStatus> = {}): OracleStatus {
  return { rateWad: 1_085_000_000_000_000_000n, updatedAt: 1000, ageSeconds: 120, stale: false, stalenessWindow: STALENESS_WINDOW, ...over };
}

// 100 EURC in → 88.234500 USDC out (units are 6dp). Fees already inside expectedOut.
const OUT = 88_234_500n;
const AMT = 100_000_000n;

function route(over: Partial<RouteQuote> = {}): RouteQuote {
  return {
    amountIn: AMT,
    bookIn: 60_000_000n, // 60% book
    ammIn: 40_000_000n, // 40% curve
    expectedOut: OUT,
    bookOut: 52_940_000n,
    ammOut: 35_294_500n,
    limitTick: 88_000,
    ammOnlyOut: 88_000_000n,
    ...over,
  };
}

const FEES: FeeParams = { poolFeeBps: 4, takerFeeBps: 2 };
const BOOK: BookStatus = { bestBidTick: 88_100, bestAskTick: 88_300 };

/** Build a fake Reads. Any field can be made to throw to simulate an RPC failure. */
function fakeReads(opts: {
  oracle?: OracleStatus | (() => never);
  route?: RouteQuote | (() => never);
  fees?: FeeParams | (() => never);
  book?: BookStatus | (() => never);
}): Reads {
  const resolve = <T>(v: T | (() => never) | undefined, fallback: T): (() => Promise<T>) => {
    return async () => {
      if (typeof v === "function") (v as () => never)();
      return (v ?? fallback) as T;
    };
  };
  return {
    oracle: resolve(opts.oracle, freshOracle()),
    routeQuote: async (_z, _a): Promise<RouteQuote> => {
      if (typeof opts.route === "function") {
        (opts.route as () => never)();
        throw new Error("unreachable");
      }
      return opts.route ?? route();
    },
    feeParams: resolve(opts.fees, FEES),
    book: resolve(opts.book, BOOK),
  };
}

test("happy path: assembles a quote with the correct split and improvement", async () => {
  const r = await quoteSwap(fakeReads({}), { zeroForOne: false, amountIn: AMT });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.quote.expectedOut, OUT);
    assert.equal(r.quote.bookShare, 0.6);
    // improvement = (88.2345 - 88.0)/88.0 ≈ 26.6 bps
    assert.ok(r.quote.improvementBps >= 26 && r.quote.improvementBps <= 27);
  }
});

test("INVARIANT: a stale oracle refuses to quote, and never calls the quoter", async () => {
  let quoterCalled = false;
  const reads: Reads = {
    ...fakeReads({ oracle: freshOracle({ stale: true, ageSeconds: 25_000 }) }),
    routeQuote: async () => {
      quoterCalled = true;
      return route();
    },
  };
  const r = await quoteSwap(reads, { zeroForOne: false, amountIn: AMT });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "stale-oracle");
  assert.equal(quoterCalled, false, "must refuse BEFORE quoting a stale market");
  assert.match(refusalMessage(r as never), /stale|paused/i);
});

test("INVARIANT: a failed read surfaces read-failed and never invents a number", async () => {
  const boom = () => {
    throw new Error("HTTP request failed: 503");
  };
  const r1 = await quoteSwap(fakeReads({ oracle: boom }), { zeroForOne: false, amountIn: AMT });
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.reason, "read-failed");

  const r2 = await quoteSwap(fakeReads({ route: boom }), { zeroForOne: false, amountIn: AMT });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.reason, "read-failed");
  // No numbers in the refusal — it's a plain "try again", not a fabricated quote.
  assert.doesNotMatch(refusalMessage(r2 as never), /\d/);
});

test("a StaleRate revert during the quote read is treated as staleness", async () => {
  const staleRevert = () => {
    throw new Error("execution reverted, selector 0xec30f4ab");
  };
  const r = await quoteSwap(fakeReads({ route: staleRevert }), { zeroForOne: false, amountIn: AMT });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "stale-oracle");
});

test("expectedOut of zero (curve paused / no route) refuses with no-route", async () => {
  const r = await quoteSwap(fakeReads({ route: route({ expectedOut: 0n }) }), { zeroForOne: false, amountIn: AMT });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "no-route");
});

test("bad amount refuses without any read", async () => {
  let touched = false;
  const reads: Reads = { ...fakeReads({}), oracle: async () => { touched = true; return freshOracle(); } };
  const r = await quoteSwap(reads, { zeroForOne: false, amountIn: 0n });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "bad-amount");
  assert.equal(touched, false);
});

test("LOCK: the receive figure equals the quoter output exactly — no fee arithmetic on top", async () => {
  // The contracts already deduct both fees inside expectedOut. If anyone ever
  // makes renderQuote subtract the fee again, this fails.
  const r = await quoteSwap(fakeReads({}), { zeroForOne: false, amountIn: AMT });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.quote.expectedOut, OUT, "assembled receive must equal the raw quoter output");
  const card = renderQuote(r.quote);
  // The exact verbatim receive string must appear; a re-subtracted fee would change it.
  assert.ok(card.includes(formatUnits6(OUT)), "card must show the verbatim receive amount");
  // And the blended fee is labelled as already included, not a deduction.
  assert.match(card, /already in the quote/i);
});

test("blended fee is the input-weighted mix of the two on-chain fees", () => {
  // 60% @ 2bps + 40% @ 4bps = 2.8 bps → shown as 0.03%
  const bps = blendedFeeBps(route(), FEES);
  assert.ok(Math.abs(bps - 2.8) < 0.01);
});

test("every rendered card names the pair USDC/EURC and spells both sides", async () => {
  const r = await quoteSwap(fakeReads({}), { zeroForOne: false, amountIn: AMT });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const card = renderQuote(r.quote);
  assert.ok(card.includes(PAIR));
  assert.ok(card.includes("EURC") && card.includes("USDC"));
  assert.match(card, /Sell .*EURC .*receive .*USDC/); // both sides, in words
});

test("describeSwap phrases buy and sell from the token given away", () => {
  assert.match(describeSwap(false, AMT, OUT), /^Sell .*EURC → receive ~.*USDC$/);
  assert.match(describeSwap(true, AMT, OUT), /^Spend .*USDC → receive ~.*EURC$/);
});

test("renderPrice shows rate age and, when present, book mid + spread; flags staleness", () => {
  const fresh = renderPrice(freshOracle(), BOOK);
  assert.ok(fresh.includes(PAIR));
  assert.match(fresh, /FX rate 1\.0850/);
  assert.match(fresh, /mid .* spread .* bps/);

  const stale = renderPrice(freshOracle({ stale: true, ageSeconds: 25_000 }), { bestBidTick: 0, bestAskTick: 0 });
  assert.match(stale, /STALE|paused/i);
  assert.match(stale, /no resting orders/i);
});

test("formatUnits6 renders 6-dp amounts with thousands separators", () => {
  assert.equal(formatUnits6(1_234_567_890n), "1,234.5678");
  assert.equal(formatUnits6(0n), "0.0000");
});
