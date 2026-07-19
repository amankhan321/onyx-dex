"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { ExternalLink } from "lucide-react";
import { ADDR, arcTestnet } from "@/lib/contracts";

/**
 * On-chain transaction history for the connected wallet, built from Onyx's own
 * contract events (TakerSwap on the Router, OrderPlaced/Cancelled on the book).
 * Read-only, scoped to the user's address, chunked getLogs over a recent window
 * so the RPC never rejects the range. Fully fault-tolerant: any failure shows an
 * empty list, never a crash.
 */
type Entry = { kind: string; detail: string; tx: string; block: bigint };

// Module-level cache: tab switches remount the panel; don't refire ~16 getLogs
// each time. One fetch per wallet per 60s.
const historyCache: Record<string, { rows: Entry[]; at: number }> = {};

const swapEvent = {
  type: "event",
  name: "TakerSwap",
  inputs: [
    { name: "taker", type: "address", indexed: true },
    { name: "zeroForOne", type: "bool", indexed: false },
    { name: "amountIn", type: "uint256", indexed: false },
    { name: "amountOut", type: "uint256", indexed: false },
    { name: "fee", type: "uint256", indexed: false },
  ],
} as const;

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

const fmt = (v: bigint) => (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });

export function TxHistory() {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: arcTestnet.id });
  const [rows, setRows] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address || !client) return;
    const cached = historyCache[address];
    if (cached && Date.now() - cached.at < 60_000) {
      setRows(cached.rows);
      return;
    }
    let alive = true;
    setLoading(true);

    (async () => {
      try {
        // ONE small range, TWO requests total. The previous 14-chunk version
        // fired ~28 getLogs at once and rate-limited the RPC — which is what
        // broke the swap quote ("HTTP request failed"). History is a nicety;
        // it must never starve the trading path.
        const latest = await client.getBlockNumber();
        const start = latest > 9_000n ? latest - 9_000n : 0n;

        const [swapsOne, placedOne] = await Promise.allSettled([
          client.getLogs({
            address: ADDR.router as `0x${string}`,
            event: swapEvent,
            args: { taker: address },
            fromBlock: start,
            toBlock: latest,
          }),
          client.getLogs({
            address: ADDR.book as `0x${string}`,
            event: placedEvent,
            args: { maker: address },
            fromBlock: start,
            toBlock: latest,
          }),
        ]);
        const swaps = [swapsOne];
        const placed = [placedOne];

        const out: Entry[] = [];
        for (const r of swaps) {
          if (r.status !== "fulfilled") continue;
          for (const l of r.value) {
            const a = l.args as { zeroForOne?: boolean; amountIn?: bigint; amountOut?: bigint };
            out.push({
              kind: "Swap",
              detail: `${fmt(a.amountIn ?? 0n)} ${a.zeroForOne ? "USDC→EURC" : "EURC→USDC"} · got ${fmt(a.amountOut ?? 0n)}`,
              tx: l.transactionHash!,
              block: l.blockNumber!,
            });
          }
        }
        for (const r of placed) {
          if (r.status !== "fulfilled") continue;
          for (const l of r.value) {
            const a = l.args as { isBid?: boolean; tick?: number; baseAmount?: bigint };
            out.push({
              kind: a.isBid ? "Bid placed" : "Ask placed",
              detail: `${fmt(a.baseAmount ?? 0n)} @ ${((a.tick ?? 0) * 1e13 / 1e18).toFixed(4)}`,
              tx: l.transactionHash!,
              block: l.blockNumber!,
            });
          }
        }
        out.sort((a, b) => Number(b.block - a.block));
        if (alive) {
          const rows25 = out.slice(0, 25);
          historyCache[address] = { rows: rows25, at: Date.now() };
          setRows(rows25);
        }
      } catch {
        /* leave empty */
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => { alive = false; };
  }, [address, client]);

  if (!address) return null;

  return (
    <div className="mt-5">
      <h3 className="text-sm font-medium text-fg">Your recent activity</h3>
      {loading && rows.length === 0 ? (
        <p className="mt-2 font-mono text-[11px] text-faint">loading…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 font-mono text-[11px] text-faint">no on-chain activity yet</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {rows.map((r) => (
            <a
              key={r.tx + r.detail}
              href={`https://testnet.arcscan.app/tx/${r.tx}`}
              target="_blank"
              rel="noreferrer"
              className="inner flex items-center justify-between p-3 hover:brightness-110"
            >
              <div className="min-w-0">
                <div className="text-xs font-medium text-fg">{r.kind}</div>
                <div className="truncate font-mono text-[11px] text-faint">{r.detail}</div>
              </div>
              <ExternalLink size={13} className="ml-2 shrink-0 text-faint" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
