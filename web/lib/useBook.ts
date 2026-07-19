"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { ADDR, arcTestnet, bookAbi, poolAbi, priceOf } from "./contracts";

export type Level = { tick: number; price: number; size: bigint };
export type Book = { bids: Level[]; asks: Level[] };

const MAX_LEVELS = 12;

/**
 * Walks the book straight off the chain — bestBid/bestAsk, then hops the tick
 * bitmap via nextBidBelow / nextAskAbove. No indexer, no subgraph, no backend.
 * The book IS the contract.
 */
const placedEvent = {
  type: "event",
  name: "OrderPlaced",
  inputs: [
    { name: "id", type: "uint64", indexed: true },
    { name: "maker", type: "address", indexed: true },
    { name: "isBid", type: "bool", indexed: false },
    { name: "tick", type: "uint32", indexed: false },
    { name: "baseAmount", type: "uint128", indexed: false },
    { name: "quoteEscrow", type: "uint256", indexed: false },
  ],
} as const;

// Tick discovery from OrderPlaced logs, cached 30s. The on-chain bitmap scan is
// hard-bounded (MAX_WORD_SCAN=64 words) — safe for takers by design, but blind
// to levels resting far from the spread (e.g. an ask at 4.00 vs best 1.50).
// Event logs see everything ever placed; stale ticks cost nothing because the
// depth check filters them (cancelled/filled levels read 0 and drop out).
// Fault-tolerant: on any failure we keep the last set, worst case = today's UI.
// Recent window, chunked. A single getLogs over ~300k blocks is rejected by most
// RPCs (silent failure -> far-tick levels never appear). We scan the last
// LOOKBACK blocks in RPC-safe CHUNK pieces; any chunk that fails just
// contributes fewer ticks, never a crash. Cached 30s.
const LOOKBACK = 120_000n;
const CHUNK = 9_000n;
let eventTicks: { bids: number[]; asks: number[] } = { bids: [], asks: [] };
let eventTicksAt = 0;

async function discoverTicks(client: NonNullable<ReturnType<typeof usePublicClient>>) {
  if (Date.now() - eventTicksAt < 30_000 && (eventTicks.bids.length || eventTicks.asks.length)) {
    return eventTicks;
  }
  try {
    const latest = await client.getBlockNumber();
    const start = latest > LOOKBACK ? latest - LOOKBACK : 0n;

    const ranges: [bigint, bigint][] = [];
    for (let from = start; from <= latest; from += CHUNK + 1n) {
      const to = from + CHUNK > latest ? latest : from + CHUNK;
      ranges.push([from, to]);
    }

    const results = await Promise.allSettled(
      ranges.map(([from, to]) =>
        client.getLogs({ address: ADDR.book as `0x${string}`, event: placedEvent, fromBlock: from, toBlock: to }),
      ),
    );

    const bids = new Set<number>();
    const asks = new Set<number>();
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const l of r.value) {
        const a = l.args as { isBid?: boolean; tick?: number };
        if (a.tick == null) continue;
        (a.isBid ? bids : asks).add(Number(a.tick));
      }
    }
    if (bids.size || asks.size) {
      eventTicks = { bids: [...bids], asks: [...asks] };
      eventTicksAt = Date.now();
    }
  } catch {
    /* keep last known set */
  }
  return eventTicks;
}

export function useBook(refetchMs = 2000) {
  // Pinned to Arc explicitly. Without this, usePublicClient() follows the
  // WALLET's chain — and if the wallet sits on mainnet (or anything not in our
  // config) it returns undefined and every read on the page silently dies.
  const client = usePublicClient({ chainId: arcTestnet.id });

  return useQuery<Book>({
    queryKey: ["book"],
    refetchInterval: refetchMs,
    refetchOnWindowFocus: true,
    enabled: !!client,
    retry: 1,
    retryDelay: 300,
    placeholderData: (prev) => prev,
    staleTime: 1500,
    queryFn: async () => {
      if (!client) return { bids: [], asks: [] };
      const book = ADDR.book as `0x${string}`;

      const read = (fn: string, args: readonly unknown[] = []) =>
        client.readContract({ address: book, abi: bookAbi, functionName: fn as never, args: args as never });

      const walkTicks = async (isBid: boolean, start: number): Promise<number[]> => {
        const ticks: number[] = [];
        let tick = start;
        while (tick !== 0 && ticks.length < MAX_LEVELS) {
          ticks.push(tick);
          tick = Number(await read(isBid ? "nextBidBelow" : "nextAskAbove", [tick]));
        }
        return ticks;
      };

      // One round-trip for both best ticks, then walk each side in parallel.
      const [bestBid, bestAsk] = await client.multicall({
        allowFailure: false,
        contracts: [
          { address: book, abi: bookAbi, functionName: "bestBid" },
          { address: book, abi: bookAbi, functionName: "bestAsk" },
        ],
      }) as [number, number];

      const [walkedBids, walkedAsks, discovered] = await Promise.all([
        walkTicks(true, Number(bestBid)),
        walkTicks(false, Number(bestAsk)),
        discoverTicks(client),
      ]);
      // Union walk + event-discovered ticks; depth check below filters dead ones.
      const bidTicks = [...new Set([...walkedBids, ...discovered.bids])];
      const askTicks = [...new Set([...walkedAsks, ...discovered.asks])];

      // All level depths (both sides) in ONE multicall.
      const all = [...bidTicks.map((t) => [true, t] as const), ...askTicks.map((t) => [false, t] as const)];
      const depths = all.length
        ? await client.multicall({
            allowFailure: true,
            contracts: all.map(([b, t]) => ({
              address: book, abi: bookAbi, functionName: "levelDepth", args: [b, t],
            })),
          })
        : [];

      const bids: Level[] = [];
      const asks: Level[] = [];
      all.forEach(([b, t], i) => {
        const r = depths[i];
        if (r?.status === "success" && (r.result as bigint) > 0n) {
          (b ? bids : asks).push({ tick: t, price: priceOf(t), size: r.result as bigint });
        }
      });
      bids.sort((a, b) => b.tick - a.tick);
      asks.sort((a, b) => a.tick - b.tick);
      return { bids, asks };
    },
  });
}

export function usePool(refetchMs = 5000) {
  // Pinned to Arc explicitly. Without this, usePublicClient() follows the
  // WALLET's chain — and if the wallet sits on mainnet (or anything not in our
  // config) it returns undefined and every read on the page silently dies.
  const client = usePublicClient({ chainId: arcTestnet.id });

  return useQuery({
    queryKey: ["pool"],
    refetchInterval: refetchMs,
    enabled: !!client,
    queryFn: async () => {
      if (!client) return null;
      const call = (fn: string, args: readonly unknown[] = []) =>
        client.readContract({
          address: ADDR.pool as `0x${string}`,
          abi: poolAbi,
          functionName: fn as never,
          args: args as never,
        });

      // ONE round-trip for all four via Multicall3, instead of four serial
      // eth_calls through the proxy. This is what was taking 10-15s.
      const c = { address: ADDR.pool as `0x${string}`, abi: poolAbi } as const;
      const [b0, b1, vp, mid] = await client.multicall({
        allowFailure: false,
        contracts: [
          { ...c, functionName: "balance0" },
          { ...c, functionName: "balance1" },
          { ...c, functionName: "getVirtualPrice" },
          { ...c, functionName: "getDy", args: [true, 1_000_000n] },
        ],
      }) as [bigint, bigint, bigint, bigint];

      return {
        balance0: b0,
        balance1: b1,
        virtualPrice: vp,
        ammPrice: Number(mid) / 1e6, // EURC per 1 USDC
      };
    },
    retry: 3,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 5000),
    placeholderData: (prev) => prev,
    staleTime: 2000,
  });
}
