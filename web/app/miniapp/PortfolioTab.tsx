"use client";

import { useCallback, useState } from "react";
import { usePublicClient } from "wagmi";
import { Check, Copy, ExternalLink } from "lucide-react";
import { ADDR, arcTestnet, erc20Abi, fmt, poolAbi } from "@/lib/contracts";
import { useSigner } from "@/lib/signer";
import { haptic } from "@/lib/telegram";
import { loadTxLog, useMiniPoll, type TxRecord } from "@/lib/useMiniPoll";
import { lpMetrics, totalValueUsdc } from "@/lib/miniMath";
import { formatAge, isStaleRateError } from "@/lib/rateKeeper";
import { EmptyState, ErrorState, Skeleton, arcscan } from "./Panel";

type PortfolioData = {
  usdc: bigint;
  eurc: bigint;
  lp: bigint;
  lpSupply: bigint;
  virtualPrice: bigint;
  balance0: bigint;
  balance1: bigint;
  /** EURC per USDC. null when the oracle is stale — balances still render. */
  rate: number | null;
  /** Seconds since the oracle last updated, when we could read it. */
  rateAgeSeconds: number | null;
};

export function PortfolioTab({ onGoDeposit }: { onGoDeposit: () => void }) {
  const signer = useSigner();
  const client = usePublicClient({ chainId: arcTestnet.id });
  const [copied, setCopied] = useState(false);
  const [txs, setTxs] = useState<TxRecord[]>([]);

  const fetcher = useCallback(async (): Promise<PortfolioData> => {
    if (!client || !signer.address) throw new Error("Wallet not ready");
    const me = signer.address;
    setTxs(loadTxLog(me));

    const res = await client.multicall({
      allowFailure: true,
      contracts: [
        { address: ADDR.usdc as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [me] },
        { address: ADDR.eurc as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [me] },
        { address: ADDR.pool as `0x${string}`, abi: poolAbi, functionName: "balanceOf", args: [me] },
        { address: ADDR.pool as `0x${string}`, abi: poolAbi, functionName: "totalSupply" },
        // getVirtualPrice() also reverts StaleRate; allowFailure keeps the rest
      // of the batch alive so LP tokens and reserves still render.
      { address: ADDR.pool as `0x${string}`, abi: poolAbi, functionName: "getVirtualPrice" },
        { address: ADDR.pool as `0x${string}`, abi: poolAbi, functionName: "balance0" },
        { address: ADDR.pool as `0x${string}`, abi: poolAbi, functionName: "balance1" },
      ],
    });
    const val = (i: number): bigint =>
      res[i]?.status === "success" ? (res[i].result as bigint) : 0n;
    const [usdc, eurc, lp, lpSupply, balance0, balance1] = [
      val(0), val(1), val(2), val(3), val(5), val(6),
    ];
    const virtualPrice = val(4);

    // The rate can legitimately be unavailable when the FX oracle is stale. That
    // must not blank the tab — balances are still true, only the conversion is
    // unknown, and the UI says so.
    // A stale oracle makes getDy revert with StaleRate (0xec30f4ab). That is a
    // known, correct state — the halt working — not a failure. Balances, LP
    // holdings and reserves need no rate, so they still render; only the
    // conversion is withheld.
    let rate: number | null = null;
    let rateAgeSeconds: number | null = null;
    try {
      const dy = (await client.readContract({
        address: ADDR.pool as `0x${string}`,
        abi: poolAbi,
        functionName: "getDy",
        args: [true, 1_000_000n],
      })) as bigint;
      rate = Number(dy) / 1e6;
    } catch (e) {
      rate = null;
      if (isStaleRateError(e)) {
        try {
          const r = await fetch("/api/status").then((x) => x.json());
          rateAgeSeconds = typeof r?.ageSeconds === "number" ? r.ageSeconds : null;
        } catch {
          /* the note degrades to "stale" without an age */
        }
      }
    }

    return { usdc, eurc, lp, lpSupply, virtualPrice, balance0, balance1, rate, rateAgeSeconds };
  }, [client, signer.address]);

  const { status, data, error, refetch } = useMiniPoll<PortfolioData>(fetcher, [signer.address]);

  const copy = async () => {
    if (!signer.address) return;
    haptic.tap();
    try {
      await navigator.clipboard.writeText(signer.address);
    } catch {
      const el = document.createElement("textarea");
      el.value = signer.address;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } catch {
        /* clipboard unavailable; the address is still readable */
      }
      document.body.removeChild(el);
    }
    setCopied(true);
    haptic.success();
    setTimeout(() => setCopied(false), 1600);
  };

  if (status === "loading" && !data) return <Skeleton rows={4} />;
  if (status === "error" && !data) return <ErrorState message={error!} onRetry={refetch} />;
  if (!data) return null;

  const total = totalValueUsdc(data.usdc, data.eurc, data.rate);
  const { share, value: lpValue } = lpMetrics(data.lp, data.lpSupply, data.virtualPrice);
  const empty = data.usdc === 0n && data.eurc === 0n && data.lp === 0n;

  return (
    <div className="space-y-3">
      {status === "error" && (
        <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/[0.08] p-2.5 text-[10px] text-yellow-600">
          Showing last known data — refresh failed.
        </p>
      )}

      <button
        onClick={copy}
        className="inner flex min-h-[44px] w-full items-center justify-between p-3"
      >
        <span className="font-mono text-[11px] text-muted">
          {signer.address?.slice(0, 10)}…{signer.address?.slice(-6)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="rounded-full border border-[color:var(--line)] px-2 py-0.5 text-[9px] text-faint">
            Testnet
          </span>
          {copied ? <Check size={12} className="text-mint" /> : <Copy size={12} className="text-faint" />}
        </span>
      </button>

      <section className="inner p-4">
        <span className="text-[10px] uppercase tracking-[0.14em] text-faint">Total value</span>
        <div className="mt-1 font-mono text-2xl tabular text-fg">
          {total === null ? "—" : total.toFixed(4)}
          <span className="ml-1.5 text-xs text-faint">USDC</span>
        </div>
        {data.rate === null && (
          <p className="mt-1 text-[10px] leading-relaxed text-yellow-600">
            FX rate stale
            {data.rateAgeSeconds !== null ? ` — last updated ${formatAge(data.rateAgeSeconds)} ago` : ""}
            , swaps paused. Your balances below are accurate.
          </p>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-faint">USDC</div>
            <div className="mt-0.5 font-mono text-sm tabular text-fg">{fmt(data.usdc)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-faint">EURC</div>
            <div className="mt-0.5 font-mono text-sm tabular text-fg">{fmt(data.eurc)}</div>
          </div>
        </div>
      </section>

      {data.lp > 0n && (
        <section className="inner p-4">
          <span className="text-[10px] uppercase tracking-[0.14em] text-faint">Liquidity position</span>
          <div className="mt-2 grid grid-cols-3 gap-2 font-mono text-[11px]">
            <div>
              <div className="text-faint">LP tokens</div>
              <div className="mt-0.5 text-fg">{fmt(data.lp)}</div>
            </div>
            <div>
              <div className="text-faint">Pool share</div>
              <div className="mt-0.5 text-fg">{(share * 100).toFixed(3)}%</div>
            </div>
            <div>
              <div className="text-faint">Value</div>
              <div className="mt-0.5 text-fg">{lpValue.toFixed(4)}</div>
            </div>
          </div>
          <p className="mt-2 text-[10px] text-faint">
            Manage liquidity on the desktop app.
          </p>
        </section>
      )}

      {empty && (
        <EmptyState
          title="No funds yet"
          hint="Add testnet USDC to start trading. It takes a minute."
          actionLabel="Get testnet funds"
          onAction={onGoDeposit}
        />
      )}

      {txs.length > 0 && (
        <section>
          <h3 className="px-1 text-[10px] uppercase tracking-[0.14em] text-faint">Recent activity</h3>
          <div className="mt-2 space-y-1.5">
            {txs.slice(0, 20).map((t) => (
              <a
                key={t.hash}
                href={arcscan(t.hash)}
                target="_blank"
                rel="noreferrer"
                className="inner flex min-h-[44px] items-center justify-between p-3"
              >
                <span className="text-xs text-fg">{t.kind}</span>
                <span className="flex items-center gap-1.5 font-mono text-[10px] text-faint">
                  {new Date(t.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  <ExternalLink size={10} />
                </span>
              </a>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
