/**
 * Onyx write-request builders — pure, signer-agnostic.
 *
 * These describe WHAT to call, never how to sign it. Both the wagmi site and the
 * Mini App build requests here and hand them to their own OnyxSigner, so the two
 * surfaces cannot drift into calling the contracts differently — which is the
 * failure mode that duplicating this logic would guarantee.
 */
import { ADDR, bookWriteAbi, erc20Abi, poolWriteAbi, routerWriteAbi, twapWriteAbi } from "./contracts";
import type { WriteRequest } from "./signer";

export const MAX_FILLS = 30;
const DEADLINE_SECONDS = 600;

export function buildApprove(token: `0x${string}`, spender: `0x${string}`, amount: bigint): WriteRequest {
  return {
    address: token,
    abi: erc20Abi as never,
    functionName: "approve",
    args: [spender, amount],
    summary: "Approve token for trading",
  };
}

export function buildSwap(p: {
  zeroForOne: boolean;
  amountIn: bigint;
  bookIn: bigint;
  expectedOut: bigint;
  limitTick: number;
  recipient: `0x${string}`;
  slippageBps: number;
}): WriteRequest {
  const minOut = (p.expectedOut * BigInt(10_000 - p.slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
  return {
    address: ADDR.router as `0x${string}`,
    abi: routerWriteAbi as never,
    functionName: "swapExactIn",
    args: [
      p.zeroForOne,
      p.amountIn,
      p.bookIn,
      minOut,
      p.limitTick,
      MAX_FILLS,
      deadline,
      p.recipient,
    ],
    summary: "Swap",
  };
}

export function buildPlaceOrder(isBid: boolean, tick: number, baseAmount: bigint): WriteRequest {
  return {
    address: ADDR.book as `0x${string}`,
    abi: bookWriteAbi as never,
    functionName: "placeOrder",
    args: [isBid, tick, baseAmount],
    summary: `${isBid ? "Buy" : "Sell"} limit order`,
  };
}

export function buildCancelOrder(id: bigint): WriteRequest {
  return {
    address: ADDR.book as `0x${string}`,
    abi: bookWriteAbi as never,
    functionName: "cancelOrder",
    args: [id],
    summary: `Cancel order #${id}`,
  };
}

export function buildClaim(): WriteRequest {
  return {
    address: ADDR.book as `0x${string}`,
    abi: bookWriteAbi as never,
    functionName: "claim",
    args: [],
    summary: "Claim fills",
  };
}

export function buildCreateTwap(p: {
  zeroForOne: boolean;
  totalAmount: bigint;
  slices: number;
  intervalSeconds: number;
  minPriceX18: bigint;
}): WriteRequest {
  return {
    address: ADDR.twap as `0x${string}`,
    abi: twapWriteAbi as never,
    functionName: "createTwap",
    args: [p.zeroForOne, p.totalAmount, p.slices, p.intervalSeconds, p.minPriceX18],
    summary: "Schedule TWAP",
  };
}

export function buildCancelTwap(id: bigint): WriteRequest {
  return {
    address: ADDR.twap as `0x${string}`,
    abi: twapWriteAbi as never,
    functionName: "cancelTwap",
    args: [id],
    summary: `Cancel TWAP #${id}`,
  };
}

export function buildAddLiquidity(a0: bigint, a1: bigint, minLp = 0n): WriteRequest {
  return {
    address: ADDR.pool as `0x${string}`,
    abi: poolWriteAbi as never,
    functionName: "addLiquidity",
    args: [a0, a1, minLp],
    summary: "Add liquidity",
  };
}
