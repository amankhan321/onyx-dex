"use client";

import { useState } from "react";
import { useReadContract } from "wagmi";
import { ADDR, arcTestnet, erc20Abi, fmt, parse } from "@/lib/contracts";
import { useSwapQuote } from "@/lib/useSwapQuote";
import { useSigner } from "@/lib/signer";
import { buildApprove, buildSwap } from "@/lib/onyxActions";
import { haptic } from "@/lib/telegram";

/**
 * Swap — the same quote, route split and price-improvement numbers the desktop
 * site shows, because both read from useSwapQuote() rather than each computing
 * their own.
 */
export function SwapTab({
  onResult,
  fallbackCap,
}: {
  onResult: (hash: string) => void;
  fallbackCap: number | null;
}) {
  const signer = useSigner();
  const [zeroForOne, setZeroForOne] = useState(true);
  const [amount, setAmount] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amountIn = parse(amount);
  const { quote, error: quoteError, improvementBps, bookShare } = useSwapQuote(zeroForOne, amountIn);

  const inSym = zeroForOne ? "USDC" : "EURC";
  const outSym = zeroForOne ? "EURC" : "USDC";

  const { data: inBal } = useReadContract({
    address: (zeroForOne ? ADDR.usdc : ADDR.eurc) as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: signer.address ? [signer.address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: Boolean(signer.address) },
  });

  const balance = (inBal as bigint | undefined) ?? 0n;
  const insufficient = amountIn > 0n && amountIn > balance;
  const overCap = fallbackCap != null && Number(amount) > fallbackCap;

  async function onSwap() {
    if (!signer.address || !quote) return;
    setError(null);
    setBusy(true);
    haptic.confirm();
    try {
      // Approve + swap go through as ONE signing session: the keystore signer
      // unlocks once, sends both, wipes.
      const reqs = [
        buildApprove((zeroForOne ? ADDR.usdc : ADDR.eurc) as `0x${string}`, ADDR.router as `0x${string}`, amountIn),
        buildSwap({
          zeroForOne,
          amountIn,
          bookIn: quote.bookIn,
          expectedOut: quote.expectedOut,
          limitTick: quote.limitTick,
          recipient: signer.address,
          slippageBps: 50,
        }),
      ];
      const hashes = await signer.writeBatch(reqs);
      haptic.success();
      onResult(hashes[hashes.length - 1]);
    } catch (e) {
      haptic.error();
      const m = e instanceof Error ? e.message : "Swap failed";
      setError(m.split("\n")[0].slice(0, 120));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="inner p-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted">You pay</span>
          <button
            onClick={() => {
              haptic.select();
              setZeroForOne((v) => !v);
            }}
            className="rounded-full border border-[color:var(--line)] px-2.5 py-1 text-[11px] font-semibold text-fg"
          >
            {inSym} → {outSym} ⇅
          </button>
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          className="mt-2 w-full bg-transparent font-mono text-3xl tabular text-fg outline-none"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="font-mono text-[11px] text-faint">bal {fmt(balance, 4)}</span>
          <div className="flex gap-1.5">
            {[0.25, 0.5, 1].map((f) => (
              <button
                key={f}
                onClick={() => {
                  haptic.tap();
                  const b = Number(balance) / 1e6;
                  const usable = inSym === "USDC" ? Math.max(0, b - 0.01) : b;
                  setAmount((usable * f).toFixed(4).replace(/\.?0+$/, ""));
                }}
                className="rounded-md border border-[color:var(--line)] px-2 py-0.5 text-[10px] text-muted"
              >
                {f === 1 ? "MAX" : `${f * 100}%`}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="inner p-4">
        <span className="text-[11px] text-muted">You receive</span>
        <div className="mt-1 font-mono text-3xl tabular text-fg">
          {quote ? fmt(quote.expectedOut) : "0.0000"}
        </div>
        <span className="font-mono text-[11px] text-faint">{outSym}</span>
      </div>

      {quote && quote.expectedOut > 0n && (
        <div className="inner p-4">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.14em] text-faint">Route</span>
            {improvementBps > 0 && (
              <span className="font-mono text-[11px] text-mint">
                +{(improvementBps / 100).toFixed(2)}% vs AMM alone
              </span>
            )}
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-mint" style={{ width: `${bookShare * 100}%` }} />
          </div>
          <div className="mt-2 flex justify-between font-mono text-[11px] text-faint">
            <span>Order book {Math.round(bookShare * 100)}%</span>
            <span>StableSwap {Math.round((1 - bookShare) * 100)}%</span>
          </div>
        </div>
      )}

      {(error || quoteError) && (
        <p className="rounded-lg border border-rose/30 bg-rose/[0.06] p-3 text-[11px] text-rose">
          {error ?? quoteError}
        </p>
      )}

      {overCap && (
        <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/[0.08] p-3 text-[11px] text-yellow-600">
          Capped at {fallbackCap} USDC while your key is in less-secure storage.
        </p>
      )}

      <button
        onClick={onSwap}
        disabled={!signer.ready || !quote || busy || insufficient || overCap}
        className="w-full rounded-full bg-indigo py-3.5 text-sm font-semibold text-white disabled:opacity-30"
      >
        {busy
          ? "Signing…"
          : insufficient
            ? `Insufficient ${inSym}`
            : overCap
              ? "Over cap"
              : "Confirm & sign"}
      </button>
    </div>
  );
}
