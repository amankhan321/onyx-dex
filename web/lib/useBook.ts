"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { ADDR, arcTestnet, bookAbi, poolAbi, priceOf } from "./contracts";

export type Level = { tick: number; price: number; size: bigint };
export type Book = { bids: Level[]; asks: Level[] };

const MAX_LEVELS = 12;
// The walk is a CHAIN of sequential round trips (each next tick depends on the
// previous), so its length directly sets first-paint latency. Strided discovery
// already covers the whole range in ONE multicall, so the walk only needs to
// guarantee the near-spread levels — 3 deep is plenty and cuts ~9 sequential
// proxy hops off the initial load.
const WALK_MAX = 3;

/**
 * Walks the book straight off the chain — bestBid/bestAsk, then hops the tick
 * bitmap via nextBidBelow / nextAskAbove. No indexer, no subgraph, no backend.
 * The book IS the contract.
 */
const STRIDE = 16384;
const MAX_SCAN = 600_000;
let discoCache: { bids: number[]; asks: number[] } = { bids: [], asks: [] };
let discoAt = 0;

async function stridedDiscover(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  book: `0x${string}`,
): Promise<{ bids: number[]; asks: number[] }> {
  try {
    const askStarts: number[] = [];
    for (let p = 0; p <= MAX_SCAN; p += STRIDE) askStarts.push(p);
    const bidStarts: number[] = [];
    for (let p = MAX_SCAN; p >= STRIDE; p -= STRIDE) bidStarts.push(p);

    const probe = async (isBid: boolean, starts: number[]) => {
      const fn = isBid ? "nextBidBelow" : "nextAskAbove";
      const res = await client.multicall({
        allowFailure: true,
        contracts: starts.map((tk) => ({ address: book, abi: bookAbi, functionName: fn, args: [tk] })),
      });
      const found = new Set<number>();
      res.forEach((r) => {
        if (r.status === "success") {
          const tk = Number(r.result as bigint);
          if (tk !== 0) found.add(tk);
        }
      });
      return [...found];
    };

    const [bids, asks] = await Promise.all([probe(true, bidStarts), probe(false, askStarts)]);
    discoCache = { bids, asks };
  } catch {
    /* keep previous cache */
  }
  return discoCache;
}

export function useBook(refetchMs = 5000) {
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

      // NO sequential reads anywhere. The old bounded walk (bestAsk ->
      // nextAskAbove one call at a time) was the last fragile piece: one
      // throttled read mid-chain threw the whole query and the book rendered
      // empty ("no asks resting" while bestAsk()==150000 on-chain — Nick's
      // cast proved it). The strided discovery finds every tick in ONE
      // multicall, so it is now the sole source: the whole refresh is ~3
      // atomic multicalls. Either a batch lands or the previous book stays.
      // Guaranteed near-spread walk (2-4 cheap reads) UNIONed with the strided
      // far-tick discovery. The walk alone can't jump gaps > 64 words; discovery
      // alone can be throttled on a given window. Together, near-spread levels
      // ALWAYS appear (bestAsk 150000 proven on-chain) and far ones appear when
      // discovery lands.
      const walkTicks = async (isBid: boolean): Promise<number[]> => {
        const fnBest = isBid ? "bestBid" : "bestAsk";
        const fnNext = isBid ? "nextBidBelow" : "nextAskAbove";
        const ticks: number[] = [];
        try {
          let tick = Number(await client.readContract({ address: book, abi: bookAbi, functionName: fnBest as never, args: [] as never }));
          while (tick !== 0 && ticks.length < WALK_MAX) {
            ticks.push(tick);
            tick = Number(await client.readContract({ address: book, abi: bookAbi, functionName: fnNext as never, args: [tick] as never }));
          }
        } catch {
          /* walk failed this cycle — discovery may still cover it */
        }
        return ticks;
      };

      const [discovered, walkedBids, walkedAsks] = await Promise.all([
        stridedDiscover(client, book),
        walkTicks(true),
        walkTicks(false),
      ]);
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
