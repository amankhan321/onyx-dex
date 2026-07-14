"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { ADDR, bookAbi, poolAbi, priceOf } from "./contracts";

export type Level = { tick: number; price: number; size: bigint };
export type Book = { bids: Level[]; asks: Level[] };

const MAX_LEVELS = 12;

/**
 * Walks the book straight off the chain — bestBid/bestAsk, then hops the tick
 * bitmap via nextBidBelow / nextAskAbove. No indexer, no subgraph, no backend.
 * The book IS the contract.
 */
export function useBook(refetchMs = 3000) {
  const client = usePublicClient();

  return useQuery<Book>({
    queryKey: ["book"],
    refetchInterval: refetchMs,
    enabled: !!client,
    queryFn: async () => {
      if (!client) return { bids: [], asks: [] };

      const read = (fn: string, args: readonly unknown[] = []) =>
        client.readContract({
          address: ADDR.book as `0x${string}`,
          abi: bookAbi,
          functionName: fn as never,
          args: args as never,
        });

      const walk = async (isBid: boolean): Promise<Level[]> => {
        let tick = Number(await read(isBid ? "bestBid" : "bestAsk"));
        const out: Level[] = [];

        while (tick !== 0 && out.length < MAX_LEVELS) {
          const size = (await read("levelDepth", [isBid, tick])) as bigint;
          if (size > 0n) out.push({ tick, price: priceOf(tick), size });
          tick = Number(await read(isBid ? "nextBidBelow" : "nextAskAbove", [tick]));
        }
        return out;
      };

      const [bids, asks] = await Promise.all([walk(true), walk(false)]);
      return { bids, asks };
    },
  });
}

export function usePool(refetchMs = 5000) {
  const client = usePublicClient();

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

      const [b0, b1, vp, mid] = await Promise.all([
        call("balance0") as Promise<bigint>,
        call("balance1") as Promise<bigint>,
        call("getVirtualPrice") as Promise<bigint>,
        call("getDy", [true, 1_000_000n]) as Promise<bigint>,
      ]);

      return {
        balance0: b0,
        balance1: b1,
        virtualPrice: vp,
        ammPrice: Number(mid) / 1e6, // EURC per 1 USDC
      };
    },
  });
}
