/**
 * Onyx trading module — quoting and UNSIGNED transaction construction.
 *
 * ============================ DESIGN CONTRACT ============================
 * Everything here is pure and framework-agnostic:
 *   • no Telegraf, no React, no process.env reads at call time
 *   • no wallet, no signer, no private key — this module CANNOT sign
 *   • reads take a viem PublicClient passed in by the caller
 *   • writes return a plain `UnsignedTx` describing the call
 *
 * That split is what lets the same code run in two places: the bot server calls
 * it to build a preview for the confirmation screen, and the Mini App calls it
 * to build the identical transaction it then signs on the user's device. One
 * implementation means the preview can't drift from what actually gets signed —
 * which matters, because the preview is what the user consents to.
 * ========================================================================
 */

import { encodeFunctionData, type Address, type PublicClient } from "viem";
import { erc20Abi, orderBookAbi, quoterAbi, routerAbi, stableSwapAbi, twapAbi } from "./abis";

/** A transaction ready to be signed. Deliberately inert. */
export type UnsignedTx = {
  to: Address;
  data: `0x${string}`;
  value: bigint;
  chainId: number;
  /** Human-readable summary for the confirmation screen. */
  summary: string;
  /**
   * Value moved, in whole token units, for client-side policy checks (the
   * Mini App's less-secure-storage cap). Optional: absent means "not a simple
   * value transfer", and the client should treat it as uncapped rather than
   * guessing from the summary text.
   */
  capValue?: number;
};

export type OnyxAddresses = {
  router: Address;
  orderBook: Address;
  quoter: Address;
  stableSwap: Address;
  twap: Address;
  usdc: Address;
  eurc: Address;
};

export type Ctx = {
  client: PublicClient;
  addresses: OnyxAddresses;
  chainId: number;
  /** ERC-20 decimals for both tokens on Arc (6). */
  decimals: number;
};

export const TICK_SIZE = 1e-5;
export const tickOf = (price: number) => Math.round(price / TICK_SIZE);
export const priceOfTick = (tick: number) => tick * TICK_SIZE;

const QUOTE_ITERS = 16;
const MAX_FILLS = 30;

export type RouteQuote = {
  amountIn: bigint;
  /** Portion of amountIn swept through the CLOB. */
  bookIn: bigint;
  /** Portion routed to the StableSwap curve. */
  ammIn: bigint;
  expectedOut: bigint;
  bookOut: bigint;
  ammOut: bigint;
  limitTick: number;
  /** What the same trade would return on the curve alone. */
  ammOnlyOut: bigint;
  /** Improvement from using the book, in bps. 0 when the book doesn't help. */
  improvementBps: number;
  /** Share of the input filled by the book, 0..1 — for the route bar. */
  bookShare: number;
  /** Execution price vs the curve's marginal price, in bps. */
  priceImpactBps: number;
};

/**
 * Quote a market swap: the optimal split between book and curve, plus the
 * AMM-only baseline so the UI can show the price improvement honestly.
 *
 * `zeroForOne` = selling token0 (USDC) for token1 (EURC).
 */
export async function quoteSwap(ctx: Ctx, zeroForOne: boolean, amountIn: bigint): Promise<RouteQuote> {
  if (amountIn <= 0n) throw new Error("Amount must be greater than zero");

  const [q, ammOnlyOut, spotOut] = await Promise.all([
    ctx.client.readContract({
      address: ctx.addresses.quoter,
      abi: quoterAbi,
      functionName: "quote",
      args: [zeroForOne, amountIn, QUOTE_ITERS],
    }),
    ctx.client.readContract({
      address: ctx.addresses.stableSwap,
      abi: stableSwapAbi,
      functionName: "getDy",
      args: [zeroForOne, amountIn],
    }),
    // Marginal price: what one unit gets. Used as the no-impact reference.
    ctx.client.readContract({
      address: ctx.addresses.stableSwap,
      abi: stableSwapAbi,
      functionName: "getDy",
      args: [zeroForOne, BigInt(10 ** ctx.decimals)],
    }),
  ]);

  const quote = q as {
    bookIn: bigint;
    ammIn: bigint;
    expectedOut: bigint;
    bookOut: bigint;
    ammOut: bigint;
    limitTick: number;
  };

  if (quote.expectedOut === 0n) {
    // Usually a stale FX oracle halting the curve — surface it as a real state,
    // not a mysterious zero.
    throw new Error("No route available right now (the curve may be paused on a stale rate)");
  }

  const improvementBps =
    (ammOnlyOut as bigint) > 0n
      ? Number(((quote.expectedOut - (ammOnlyOut as bigint)) * 10_000n) / (ammOnlyOut as bigint))
      : 0;

  // Impact = how far the achieved rate sits below the marginal rate.
  const oneUnit = BigInt(10 ** ctx.decimals);
  const idealOut = ((spotOut as bigint) * amountIn) / oneUnit;
  const priceImpactBps =
    idealOut > 0n ? Math.max(0, Number(((idealOut - quote.expectedOut) * 10_000n) / idealOut)) : 0;

  return {
    amountIn,
    bookIn: quote.bookIn,
    ammIn: quote.ammIn,
    expectedOut: quote.expectedOut,
    bookOut: quote.bookOut,
    ammOut: quote.ammOut,
    limitTick: Number(quote.limitTick),
    ammOnlyOut: ammOnlyOut as bigint,
    improvementBps: Math.max(0, improvementBps),
    bookShare: amountIn > 0n ? Number((quote.bookIn * 10_000n) / amountIn) / 10_000 : 0,
    priceImpactBps,
  };
}

/** Does this trade need an approval first? Read-only. */
export async function needsApproval(
  ctx: Ctx,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
): Promise<boolean> {
  const allowance = (await ctx.client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender],
  })) as bigint;
  return allowance < amount;
}

export function buildApprove(ctx: Ctx, token: Address, spender: Address, amount: bigint): UnsignedTx {
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
    value: 0n,
    chainId: ctx.chainId,
    summary: `Approve ${fmtUnits(amount, ctx.decimals)} for trading`,
  };
}

/**
 * Market swap. `slippageBps` sets the on-chain floor: the transaction reverts
 * rather than filling worse than this, so a stale quote costs gas, never funds.
 */
export function buildMarketSwap(
  ctx: Ctx,
  params: {
    zeroForOne: boolean;
    quote: RouteQuote;
    recipient: Address;
    slippageBps: number;
    deadlineSeconds?: number;
  },
): UnsignedTx {
  const { zeroForOne, quote, recipient, slippageBps } = params;
  if (slippageBps < 0 || slippageBps > 10_000) throw new Error("Invalid slippage");

  const minOut = (quote.expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (params.deadlineSeconds ?? 600));

  const inSym = zeroForOne ? "USDC" : "EURC";
  const outSym = zeroForOne ? "EURC" : "USDC";

  return {
    to: ctx.addresses.router,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: "swapExactIn",
      args: [
        zeroForOne,
        quote.amountIn,
        quote.bookIn,
        minOut,
        quote.limitTick,
        MAX_FILLS,
        deadline,
        recipient,
      ],
    }),
    value: 0n,
    chainId: ctx.chainId,
    summary:
      `Swap ${fmtUnits(quote.amountIn, ctx.decimals)} ${inSym} → ` +
      `~${fmtUnits(quote.expectedOut, ctx.decimals)} ${outSym} ` +
      `(min ${fmtUnits(minOut, ctx.decimals)})`,
    capValue: Number(quote.amountIn) / 10 ** ctx.decimals,
  };
}

/**
 * Post-only limit order. The book rejects an order that would cross the
 * spread, so we check first and fail with an explanation instead of letting the
 * user burn gas on a revert they won't understand.
 */
export async function buildLimitOrder(
  ctx: Ctx,
  params: { isBid: boolean; price: number; baseAmount: bigint },
): Promise<UnsignedTx> {
  const { isBid, price, baseAmount } = params;
  if (!(price > 0)) throw new Error("Price must be greater than zero");
  if (baseAmount <= 0n) throw new Error("Size must be greater than zero");

  const [bestBid, bestAsk] = await Promise.all([
    ctx.client.readContract({ address: ctx.addresses.orderBook, abi: orderBookAbi, functionName: "bestBid" }),
    ctx.client.readContract({ address: ctx.addresses.orderBook, abi: orderBookAbi, functionName: "bestAsk" }),
  ]);

  const askPrice = Number(bestAsk) === 0 ? null : priceOfTick(Number(bestAsk));
  const bidPrice = Number(bestBid) === 0 ? null : priceOfTick(Number(bestBid));

  if (isBid && askPrice !== null && price >= askPrice) {
    throw new Error(
      `A bid at ${price.toFixed(5)} would cross the best ask (${askPrice.toFixed(5)}). ` +
        `Post-only orders are rejected when they cross — lower the price, or use a market buy.`,
    );
  }
  if (!isBid && bidPrice !== null && price <= bidPrice) {
    throw new Error(
      `An ask at ${price.toFixed(5)} would cross the best bid (${bidPrice.toFixed(5)}). ` +
        `Post-only orders are rejected when they cross — raise the price, or use a market sell.`,
    );
  }

  return {
    to: ctx.addresses.orderBook,
    data: encodeFunctionData({
      abi: orderBookAbi,
      functionName: "placeOrder",
      args: [isBid, tickOf(price), baseAmount],
    }),
    value: 0n,
    chainId: ctx.chainId,
    summary: `${isBid ? "Buy" : "Sell"} ${fmtUnits(baseAmount, ctx.decimals)} USDC @ ${price.toFixed(5)} EURC`,
  };
}

export function buildCancelOrder(ctx: Ctx, orderId: bigint): UnsignedTx {
  return {
    to: ctx.addresses.orderBook,
    data: encodeFunctionData({ abi: orderBookAbi, functionName: "cancelOrder", args: [orderId] }),
    value: 0n,
    chainId: ctx.chainId,
    summary: `Cancel order #${orderId.toString()}`,
  };
}

export function buildClaimFills(ctx: Ctx): UnsignedTx {
  return {
    to: ctx.addresses.orderBook,
    data: encodeFunctionData({ abi: orderBookAbi, functionName: "claim", args: [] }),
    value: 0n,
    chainId: ctx.chainId,
    summary: "Claim filled amounts and released escrow",
  };
}

/**
 * TWAP. The per-slice price floor is enforced on-chain, so a keeper can decline
 * to execute but can never fill the user worse than `minPrice`.
 */
export function buildTwap(
  ctx: Ctx,
  params: {
    zeroForOne: boolean;
    totalAmount: bigint;
    slices: number;
    intervalSeconds: number;
    minPrice: number;
  },
): UnsignedTx {
  const { zeroForOne, totalAmount, slices, intervalSeconds, minPrice } = params;
  if (totalAmount <= 0n) throw new Error("Total must be greater than zero");
  if (!Number.isInteger(slices) || slices < 1) throw new Error("Slices must be a positive whole number");
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) throw new Error("Interval must be at least 1 second");
  if (!(minPrice > 0)) throw new Error("Minimum price must be greater than zero");

  const minPriceX18 = BigInt(Math.floor(minPrice * 1e18));

  return {
    to: ctx.addresses.twap,
    data: encodeFunctionData({
      abi: twapAbi,
      functionName: "createTwap",
      args: [zeroForOne, totalAmount, slices, intervalSeconds, minPriceX18],
    }),
    value: 0n,
    chainId: ctx.chainId,
    summary:
      `TWAP sell ${fmtUnits(totalAmount, ctx.decimals)} ${zeroForOne ? "USDC" : "EURC"} ` +
      `in ${slices} slices every ${intervalSeconds}s, floor ${minPrice.toFixed(5)}`,
  };
}

export function buildCancelTwap(ctx: Ctx, twapId: bigint): UnsignedTx {
  return {
    to: ctx.addresses.twap,
    data: encodeFunctionData({ abi: twapAbi, functionName: "cancelTwap", args: [twapId] }),
    value: 0n,
    chainId: ctx.chainId,
    summary: `Cancel TWAP #${twapId.toString()} and refund the remainder`,
  };
}

/**
 * The full ordered set of transactions a market swap needs: an approval only
 * when the allowance is short, then the swap. Returned as a list so the Mini
 * App can walk the user through them in sequence.
 */
export async function planMarketSwap(
  ctx: Ctx,
  params: {
    zeroForOne: boolean;
    amountIn: bigint;
    owner: Address;
    slippageBps: number;
  },
): Promise<{ quote: RouteQuote; steps: UnsignedTx[] }> {
  const quote = await quoteSwap(ctx, params.zeroForOne, params.amountIn);
  const token = params.zeroForOne ? ctx.addresses.usdc : ctx.addresses.eurc;

  const steps: UnsignedTx[] = [];
  if (await needsApproval(ctx, token, params.owner, ctx.addresses.router, params.amountIn)) {
    steps.push(buildApprove(ctx, token, ctx.addresses.router, params.amountIn));
  }
  steps.push(
    buildMarketSwap(ctx, {
      zeroForOne: params.zeroForOne,
      quote,
      recipient: params.owner,
      slippageBps: params.slippageBps,
    }),
  );
  return { quote, steps };
}

/** 6-dec aware formatter used in summaries the user actually reads. */
export function fmtUnits(v: bigint, decimals: number, dp = 4): string {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, dp).replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}
