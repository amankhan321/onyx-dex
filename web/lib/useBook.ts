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
export function useBook(refetchMs = 3000) {
  // Pinned to Arc explicitly. Without this, usePublicClient() follows the
  // WALLET's chain — and if the wallet sits on mainnet (or anything not in our
  // config) it returns undefined and every read on the page silently dies.
  const client = usePublicClient({ chainId: arcTestnet.id });

  return useQuery<Book>({
    queryKey: ["book"],
    refetchInterval: refetchMs,
    enabled: !!client,
    retry: 3,
    retryDelay: (n) => Math.min(1000 * 2 ** n, 5000),
    // Never blank the book on refetch — keep the last ladder on screen while the
    // next one loads. This is what killed the "shows nothing for 20-30s" feel.
    placeholderData: (prev) => prev,
    staleTime: 2000,
    queryFn: async () => {
      if (!client) return { bids: [], asks: [] };
      const book = ADDR.book as `0x${string}`;

      const read = (fn: string, args: readonly unknown[] = []) =>
        client.readContract({ address: book, abi: bookAbi, functionName: fn as never, args: args as never });

      // Walk only the TICKS sequentially (each next depends on the last), then
      // fetch every level's depth in ONE Multicall3 call instead of a slow
      // per-level round-trip. Cuts ~2N sequential calls down to ~N+1.
      const walk = async (isBid: boolean): Promise<Level[]> => {
        const ticks: number[] = [];
        let tick = Number(await read(isBid ? "bestBid" : "bestAsk"));
        while (tick !== 0 && ticks.length < MAX_LEVELS) {
          ticks.push(tick);
          tick = Number(await read(isBid ? "nextBidBelow" : "nextAskAbove", [tick]));
        }
        if (ticks.length === 0) return [];

        const depths = (await client.multicall({
          allowFailure: false,
          contracts: ticks.map((t) => ({
            address: book, abi: bookAbi, functionName: "levelDepth", args: [isBid, t],
          })),
        })) as bigint[];

        const out: Level[] = [];
        ticks.forEach((t, i) => {
          if (depths[i] > 0n) out.push({ tick: t, price: priceOf(t), size: depths[i] });
        });
        return out;
      };

      const [bids, asks] = await Promise.all([walk(true), walk(false)]);
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
