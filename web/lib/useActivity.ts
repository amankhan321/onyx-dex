"use client";

import { useCallback, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { arcTestnet } from "./contracts";
import {
  loadActivity,
  shouldGiveUp,
  updateActivity,
  type ActivityEntry,
} from "./activityLog";

/**
 * Keeps the local activity record in step with the chain.
 *
 * Resolves pending entries with eth_getTransactionReceipt through /api/rpc —
 * one call per unresolved hash, and only for hashes we are still waiting on, so
 * a long history costs nothing. No getLogs.
 */
export function useActivity(address?: `0x${string}`) {
  const client = usePublicClient({ chainId: arcTestnet.id });
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  const reload = useCallback(() => {
    if (address) setEntries(loadActivity(address));
  }, [address]);

  useEffect(() => reload(), [reload]);

  // Another tab (or the swap flow) may append while this list is mounted.
  useEffect(() => {
    const onStorage = () => reload();
    window.addEventListener("storage", onStorage);
    window.addEventListener("onyx:activity", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("onyx:activity", onStorage);
    };
  }, [reload]);

  const refresh = useCallback(async () => {
    if (!client || !address) return;
    const pending = loadActivity(address).filter((e) => e.status === "pending");
    if (pending.length === 0) return;

    let changed = false;
    for (const e of pending) {
      // Stop asking eventually, but call it "unknown" rather than failed — a
      // receipt we never saw is not evidence the transaction failed.
      if (shouldGiveUp(e)) {
        updateActivity(address, e.hash, { status: "unknown", resolvedAt: Date.now() });
        changed = true;
        continue;
      }
      try {
        const receipt = await client.getTransactionReceipt({ hash: e.hash as `0x${string}` });
        updateActivity(address, e.hash, {
          status: receipt.status === "success" ? "confirmed" : "failed",
          error: receipt.status === "success" ? undefined : "Reverted on-chain",
          resolvedAt: Date.now(),
        });
        changed = true;
      } catch {
        // No receipt yet is the normal case for a fresh broadcast — leave it
        // pending rather than inventing an outcome.
      }
    }
    if (changed) reload();
  }, [client, address, reload]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 12_000);
    return () => clearInterval(id);
  }, [refresh]);

  return { entries, refresh, reload };
}

/** Let a mounted list know a new entry was just written. */
export function notifyActivity() {
  window.dispatchEvent(new Event("onyx:activity"));
}
