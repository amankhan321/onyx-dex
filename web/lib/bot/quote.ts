/**
 * Quoting policy and the shared rendering both chat modes use.
 *
 * Pure and viem-free so the guards can be tested without a chain: the actual
 * on-chain reads live behind the `Reads` interface, implemented by reader.ts for
 * production and by a fake in tests. This is the same split as intents.ts —
 * testable policy, thin adapter.
 *
 * Two rules the brief and the on-chain code pin down, enforced here:
 *   - NEVER invent a number. If a read fails, the result says so; it does not
 *     fall back to a stale or guessed figure.
 *   - If the FX oracle is stale, refuse to quote a swap and say so plainly.
 *
 * And one that the contracts pin down (StableSwap.getDy and Quoter both deduct
 * their fee INSIDE the number they return): the "you receive" figure is the
 * quoter's `expectedOut` verbatim. The blended fee is shown for information
 * only, already included — it is never subtracted from the receive amount.
 */

import { STALENESS_WINDOW, formatAge, isStaleRateError } from "../rateKeeper";

/** The only live market. Every card names it explicitly, by decision, so nothing
 *  breaks by habit when a second market appears. */
export const PAIR = "USDC/EURC";
const DECIMALS = 6;

export type OracleStatus = {
  /** FX rate in 1e18 fixed point, as GuardedRateProvider stores it. */
  rateWad: bigint;
  updatedAt: number;
  ageSeconds: number;
  stale: boolean;
  stalenessWindow: number;
};

/** Raw route quote as the on-chain Quoter returns it (fees already deducted). */
export type RouteQuote = {
  amountIn: bigint;
  bookIn: bigint;
  ammIn: bigint;
  /** Net of all fees — display verbatim, never adjust. */
  expectedOut: bigint;
  bookOut: bigint;
  ammOut: bigint;
  limitTick: number;
  /** What the curve alone would return — for the honest improvement figure. */
  ammOnlyOut: bigint;
};

/** Immutable fee parameters, read on-chain (never hardcoded). */
export type FeeParams = { poolFeeBps: number; takerFeeBps: number };

export type BookStatus = {
  /** 0 when that side is empty. */
  bestBidTick: number;
  bestAskTick: number;
};

/** The chain reads the quote policy depends on. reader.ts implements this. */
export interface Reads {
  oracle(): Promise<OracleStatus>;
  routeQuote(zeroForOne: boolean, amountIn: bigint): Promise<RouteQuote>;
  feeParams(): Promise<FeeParams>;
  book(): Promise<BookStatus>;
}

/** Assembled, display-ready quote. `expectedOut` is verbatim from the quoter. */
export type SwapQuote = {
  zeroForOne: boolean;
  amountIn: bigint;
  expectedOut: bigint;
  bookIn: bigint;
  ammIn: bigint;
  /** Share of input filled by the book, 0..1. */
  bookShare: number;
  /** Improvement over curve-only, in bps (>= 0). */
  improvementBps: number;
  /** Blended trading fee in bps — ALREADY included in expectedOut. Info only. */
  blendedFeeBps: number;
  oracle: OracleStatus;
};

export type QuoteResult =
  | { ok: true; quote: SwapQuote }
  | { ok: false; reason: "stale-oracle"; oracle: OracleStatus }
  | { ok: false; reason: "no-route" }
  | { ok: false; reason: "bad-amount" }
  | { ok: false; reason: "read-failed"; detail: string };

const TICK_SIZE = 1e-5;

/** Blended fee from the route split, weighted by input. Both legs' fees are ~2-4
 *  bps, so input- vs output-weighting differ by well under 0.01 bp; input keeps
 *  it simple and honest. Returned in bps. */
export function blendedFeeBps(route: RouteQuote, fees: FeeParams): number {
  const total = route.bookIn + route.ammIn;
  if (total <= 0n) return 0;
  const weighted =
    route.bookIn * BigInt(Math.round(fees.takerFeeBps * 1000)) +
    route.ammIn * BigInt(Math.round(fees.poolFeeBps * 1000));
  return Number(weighted / total) / 1000;
}

/**
 * Quote a swap with the required guards. Stale oracle → refuse before quoting.
 * Any read failure → `read-failed` (never a fabricated number). A StaleRate
 * revert surfacing from the quote read is treated as staleness. expectedOut of
 * zero (curve paused / no route) → `no-route`.
 */
export async function quoteSwap(
  reads: Reads,
  args: { zeroForOne: boolean; amountIn: bigint },
): Promise<QuoteResult> {
  if (args.amountIn <= 0n) return { ok: false, reason: "bad-amount" };

  let oracle: OracleStatus;
  try {
    oracle = await reads.oracle();
  } catch (e) {
    return { ok: false, reason: "read-failed", detail: short(e) };
  }
  if (oracle.stale) return { ok: false, reason: "stale-oracle", oracle };

  let route: RouteQuote;
  let fees: FeeParams;
  try {
    [route, fees] = await Promise.all([reads.routeQuote(args.zeroForOne, args.amountIn), reads.feeParams()]);
  } catch (e) {
    if (isStaleRateError(e)) return { ok: false, reason: "stale-oracle", oracle };
    return { ok: false, reason: "read-failed", detail: short(e) };
  }

  if (route.expectedOut === 0n) return { ok: false, reason: "no-route" };

  const bookShare = args.amountIn > 0n ? Number((route.bookIn * 10_000n) / args.amountIn) / 10_000 : 0;
  const improvementBps =
    route.ammOnlyOut > 0n
      ? Math.max(0, Number(((route.expectedOut - route.ammOnlyOut) * 10_000n) / route.ammOnlyOut))
      : 0;

  return {
    ok: true,
    quote: {
      zeroForOne: args.zeroForOne,
      amountIn: args.amountIn,
      expectedOut: route.expectedOut, // verbatim — fees already inside it
      bookIn: route.bookIn,
      ammIn: route.ammIn,
      bookShare,
      improvementBps,
      blendedFeeBps: blendedFeeBps(route, fees),
      oracle,
    },
  };
}

// ------------------------------- rendering --------------------------------
// One renderer, shared by /quote (Mode 1) and the Mode-2 confirmation card, so
// the two can't drift in wording, numbers, or error language.

export const tokenGiven = (zeroForOne: boolean): "USDC" | "EURC" => (zeroForOne ? "USDC" : "EURC");
export const tokenReceived = (zeroForOne: boolean): "USDC" | "EURC" => (zeroForOne ? "EURC" : "USDC");

/** 6-decimal units → string. Pure (contracts.fmt pulls in viem via the chain). */
export function formatUnits6(v: bigint, dp = 4): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(DECIMALS);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = frac.toString().padStart(DECIMALS, "0").slice(0, dp);
  const wholeStr = whole.toLocaleString("en-US");
  return `${neg ? "-" : ""}${wholeStr}${dp > 0 ? "." + fracStr : ""}`;
}

/**
 * Both sides in words, per decision, e.g.
 *   "Sell 100 EURC → receive ~88.2345 USDC"
 *   "Spend 100 USDC → receive ~92.5012 EURC"
 * `expectedOut` is shown verbatim.
 */
export function describeSwap(zeroForOne: boolean, amountIn: bigint, expectedOut: bigint): string {
  const give = tokenGiven(zeroForOne);
  const get = tokenReceived(zeroForOne);
  const verb = zeroForOne ? "Spend" : "Sell";
  return `${verb} ${formatUnits6(amountIn)} ${give} → receive ~${formatUnits6(expectedOut)} ${get}`;
}

export function formatRouteSplit(bookShare: number): string {
  const book = Math.round(bookShare * 100);
  return `Route: ${book}% book · ${100 - book}% curve`;
}

/**
 * Rate with its age. When stale the real rate is still shown — never hidden and
 * never substituted with 0, so a halted feed reads as an error state rather than
 * an empty one.
 */
export function formatRateLine(oracle: OracleStatus): string {
  const rate = Number(oracle.rateWad) / 1e18;
  const age = formatAge(oracle.ageSeconds);
  return oracle.stale
    ? `FX rate ${rate.toFixed(4)} · ${age} old — STALE, instant swaps paused by design until the next rate update`
    : `FX rate ${rate.toFixed(4)} · ${age} old`;
}

function priceOfTick(tick: number): number {
  return tick * TICK_SIZE;
}

/**
 * /price view: names the pair, oracle rate + age (even when stale), book mid +
 * spread. The book section is independent of the oracle — an empty book and a
 * halted oracle are different states and read differently.
 */
export function renderPrice(oracle: OracleStatus, book: BookStatus): string {
  const lines = [PAIR, formatRateLine(oracle)];
  if (book.bestBidTick > 0 && book.bestAskTick > 0) {
    const bid = priceOfTick(book.bestBidTick);
    const ask = priceOfTick(book.bestAskTick);
    const mid = (bid + ask) / 2;
    const spreadBps = mid > 0 ? ((ask - bid) / mid) * 10_000 : 0;
    lines.push(`Book mid ${mid.toFixed(5)} · spread ${spreadBps.toFixed(1)} bps`);
  } else {
    lines.push("Book: no resting orders on one or both sides");
  }
  // The book has no oracle dependency, so say what still works.
  if (oracle.stale) lines.push(`The USDC/EURC limit order book is unaffected: ${STALE_ROUTE_CHAT}`);
  return lines.join("\n");
}

/** /quote and confirmation card body. Always names the pair and spells both sides. */
export function renderQuote(q: SwapQuote): string {
  const lines = [
    PAIR,
    describeSwap(q.zeroForOne, q.amountIn, q.expectedOut),
    formatRouteSplit(q.bookShare),
    `Fee ${q.blendedFeeBps.toFixed(2)}% (already in the quote)`,
  ];
  if (q.improvementBps > 0) lines.push(`Book saves ~${(q.improvementBps / 100).toFixed(2)}% vs curve alone`);
  lines.push(formatRateLine(q.oracle));
  return lines.join("\n");
}

/**
 * The ONE stale-oracle reason, shared by the chat bot, the Mini App
 * (useSwapQuote) and the site (components/Swap). It lived as three separate
 * string literals that had to be edited in lockstep; a single constant is why
 * they can no longer drift.
 *
 * Why a route can still be offered: RateProvider.getRate() is called only by
 * StableSwap — swap (:110, :126) and addLiquidity (:200). OrderBook has no
 * oracle dependency at all (prices are maker-set ticks), so the limit book
 * keeps working, and removeLiquidity is purely proportional (:262) so LPs can
 * still withdraw. TWAP is deliberately never offered as the fallback: its
 * slices execute against the AMM and would fail one by one.
 */
export const STALE_SWAP_SHORT = "FX oracle stale — instant swaps paused by design until the next rate update";

/**
 * The ROUTE is per-surface, because "/limit" is only actionable where a chat
 * prompt exists. The reason above stays identical everywhere; only the way out
 * differs. Kept side by side here so the three remain reviewable together.
 */

/** Telegram chat: slash commands are typed directly. */
export const STALE_ROUTE_CHAT = "/limit still works — you set the price yourself.";

/** Public site: there is a Limit panel on the same page. No slash commands in a browser. */
export const STALE_ROUTE_SITE =
  "The order book is unaffected — use the Limit panel on this page to set your own price.";

/** Mini App: no limit UI exists there; limit orders are placed from the bot chat. */
export const STALE_ROUTE_MINIAPP =
  "The order book is unaffected — place a limit order from the Onyx bot chat with /limit.";

/** Chat-length message with the rate's age filled in. */
export function staleSwapMessage(ageSeconds: number): string {
  return (
    `FX oracle is stale (rate ${formatAge(ageSeconds)} old) — instant swaps are paused by design ` +
    `until the next rate update. The USDC/EURC limit order book is unaffected: ${STALE_ROUTE_CHAT}`
  );
}

// --------------------------- stale-oracle policy ---------------------------

/**
 * Does this command need the AMM (and therefore a live FX rate)?
 *
 * Market swaps and TWAP do: both price through StableSwap, whose getRate()
 * reverts once the rate is past STALENESS_WINDOW. TWAP is included precisely
 * because its slices hit the AMM — offering it during a halt would fail slice
 * by slice.
 *
 * /limit does NOT: OrderBook carries no oracle dependency and the user supplies
 * the price, so a resting order is placed at a maker-set tick regardless of the
 * rate. /cancel and /withdraw touch neither the curve nor a quote.
 */
export function requiresLiveRate(command: string): boolean {
  return command === "buy" || command === "sell" || command === "twap" || command === "quote";
}

/** Commands that keep working through a halt — reads plus the book itself. */
export function survivesStaleOracle(command: string): boolean {
  return !requiresLiveRate(command);
}

/**
 * Gate a command on oracle state. Returns null when the command may proceed,
 * or the refusal text when it may not. The refusal always points at /limit,
 * never at /twap.
 */
export function staleGate(command: string, oracle: Pick<OracleStatus, "stale" | "ageSeconds">): string | null {
  if (!oracle.stale) return null;
  if (survivesStaleOracle(command)) return null;
  return staleSwapMessage(oracle.ageSeconds);
}

/** Human-readable refusal — never a number. Matches the app's existing wording. */
export function refusalMessage(r: Exclude<QuoteResult, { ok: true }>): string {
  switch (r.reason) {
    case "stale-oracle":
      return `${staleSwapMessage(r.oracle.ageSeconds)} No quote right now.`;
    case "no-route":
      return "No route available right now — the curve may be paused on a stale rate. No quote.";
    case "bad-amount":
      return "Amount must be greater than zero.";
    case "read-failed":
      return "Couldn't read the chain just now, so I won't guess a number. Try again in a moment.";
  }
}

function short(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.slice(0, 120);
}
