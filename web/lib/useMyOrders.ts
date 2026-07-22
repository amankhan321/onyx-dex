"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { ADDR, arcTestnet, bookAbi } from "./contracts";

export type MyOrder = { id: string; side: string; price: string; size: string; tx: string };

/**
 * Open orders that survive refresh AND tab switches.
 *
 * Persisted to localStorage per wallet, then VERIFIED against chain on load:
 * we multicall orders(id) and keep only those still active with size resting,
 * dropping anything filled or cancelled. So the list is durable (local) but
 * always reconciled to on-chain truth (orders(id) is a plain reliable read —
 * no getLogs). Add on placement, remove on cancel.
 */
export function useMyOrders() {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: arcTestnet.id });
  const [orders, setOrders] = useState<MyOrder[]>([]);

  const key = address ? `onyx-orders-${address.toLowerCase()}` : null;

  // Load from storage + reconcile with chain.
  useEffect(() => {
    if (!key || !client) return;
    let alive = true;
    let stored: MyOrder[] = [];
    try {
      stored = JSON.parse(localStorage.getItem(key) ?? "[]");
    } catch {
      stored = [];
    }
    if (stored.length === 0) {
      setOrders([]);
      return;
    }
    setOrders(stored); // show immediately; prune after verify

    (async () => {
      try {
        const res = await client.multicall({
          allowFailure: true,
          contracts: stored.map((o) => ({
            address: ADDR.book as `0x${string}`,
            abi: bookAbi,
            functionName: "orders",
            args: [BigInt(o.id)],
          })),
        });
        const live = stored.filter((_, i) => {
          const r = res[i];
          if (r.status !== "success") return true; // keep on read failure
          // viem returns public struct getters as a POSITIONAL array:
          // [maker, tick, isBid, active, baseAmount, baseFilled, quoteEscrow, prev, next].
          // Reading .active off that array was always undefined, so every order
          // got pruned on load — the "vanishes on refresh" bug.
          const v = r.result as unknown as [string, number, boolean, boolean, bigint, bigint, bigint, bigint, bigint];
          return v[3] && v[4] > v[5];
        });
        if (alive) {
          setOrders(live);
          localStorage.setItem(key, JSON.stringify(live));
        }
      } catch {
        /* keep what we have */
      }
    })();

    return () => {
      alive = false;
    };
  }, [key, client]);

  const add = useCallback(
    (o: MyOrder) => {
      setOrders((prev) => {
        const next = [o, ...prev.filter((x) => x.id !== o.id)];
        if (key) localStorage.setItem(key, JSON.stringify(next));
        return next;
      });
    },
    [key],
  );

  const remove = useCallback(
    (id: string) => {
      setOrders((prev) => {
        const next = prev.filter((o) => o.id !== id);
        if (key) localStorage.setItem(key, JSON.stringify(next));
        return next;
      });
    },
    [key],
  );

  return { orders, add, remove };
}
