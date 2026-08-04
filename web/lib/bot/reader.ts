/**
 * Server-side chain reader — the bot's own RPC access, with the SAME retry and
 * backoff as the keeper (web/lib/rpcRetry). Node-only: it runs in API routes and
 * the webhook handler, which carry no browser Origin and so are not 403'd by
 * Arc. It never signs and never holds a key.
 *
 * This is the thin adapter behind the `Reads` interface; the guard logic and all
 * rendering live in the pure quote.ts, which is where the tests are.
 *
 * viem's own retry is disabled here so the keeper's policy (which also handles
 * Arc's -32011 "request limit reached") is the single source of retry
 * behaviour, rather than two schemes layered on top of each other.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { ADDR, arcTestnet, bookAbi, poolAbi, quoterAbi, rateAbi } from "@/lib/contracts";
import { STALENESS_WINDOW } from "@/lib/rateKeeper";
import { withRetry } from "@/lib/rpcRetry";
import type { BookStatus, FeeParams, OracleStatus, Reads, RouteQuote } from "./quote";

const QUOTE_ITERS = 16; // identical to useSwapQuote so chat and UI agree exactly

/** A public client on the server's default transport (no Origin → no 403). */
export function serverPublicClient(): PublicClient {
  return createPublicClient({
    chain: arcTestnet,
    // retryCount 0: withRetry owns retries, matching the keeper.
    transport: http(undefined, { batch: false, retryCount: 0, timeout: 12_000 }),
  });
}

type RawQuote = {
  bookIn: bigint;
  ammIn: bigint;
  expectedOut: bigint;
  bookOut: bigint;
  ammOut: bigint;
  limitTick: number | bigint;
};

export function makeReads(client: PublicClient = serverPublicClient()): Reads {
  return {
    async oracle(): Promise<OracleStatus> {
      return withRetry(async () => {
        const [rate, updatedAt, block] = await Promise.all([
          client.readContract({ address: ADDR.rateProvider as `0x${string}`, abi: rateAbi, functionName: "rate" }) as Promise<bigint>,
          client.readContract({ address: ADDR.rateProvider as `0x${string}`, abi: rateAbi, functionName: "updatedAt" }) as Promise<bigint>,
          client.getBlock(),
        ]);
        const ageSeconds = Number(block.timestamp) - Number(updatedAt);
        return {
          rateWad: rate,
          updatedAt: Number(updatedAt),
          ageSeconds,
          stale: ageSeconds > STALENESS_WINDOW,
          stalenessWindow: STALENESS_WINDOW,
        };
      });
    },

    async routeQuote(zeroForOne: boolean, amountIn: bigint): Promise<RouteQuote> {
      return withRetry(async () => {
        const [q, ammOnly] = await Promise.all([
          client.readContract({
            address: ADDR.quoter as `0x${string}`,
            abi: quoterAbi,
            functionName: "quote",
            args: [zeroForOne, amountIn, QUOTE_ITERS],
          }) as Promise<RawQuote>,
          client.readContract({
            address: ADDR.pool as `0x${string}`,
            abi: poolAbi,
            functionName: "getDy",
            args: [zeroForOne, amountIn],
          }) as Promise<bigint>,
        ]);
        return {
          amountIn,
          bookIn: q.bookIn,
          ammIn: q.ammIn,
          expectedOut: q.expectedOut,
          bookOut: q.bookOut,
          ammOut: q.ammOut,
          limitTick: Number(q.limitTick),
          ammOnlyOut: ammOnly,
        };
      });
    },

    async feeParams(): Promise<FeeParams> {
      return withRetry(async () => {
        const [poolFee, takerFee] = await Promise.all([
          client.readContract({ address: ADDR.pool as `0x${string}`, abi: poolAbi, functionName: "feeBps" }) as Promise<bigint>,
          client.readContract({ address: ADDR.book as `0x${string}`, abi: bookAbi, functionName: "takerFeeBps" }) as Promise<bigint>,
        ]);
        return { poolFeeBps: Number(poolFee), takerFeeBps: Number(takerFee) };
      });
    },

    async book(): Promise<BookStatus> {
      return withRetry(async () => {
        const [bid, ask] = await Promise.all([
          client.readContract({ address: ADDR.book as `0x${string}`, abi: bookAbi, functionName: "bestBid" }) as Promise<number>,
          client.readContract({ address: ADDR.book as `0x${string}`, abi: bookAbi, functionName: "bestAsk" }) as Promise<number>,
        ]);
        return { bestBidTick: Number(bid), bestAskTick: Number(ask) };
      });
    },
  };
}
