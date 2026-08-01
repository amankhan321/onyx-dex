"use client";

import { useState } from "react";
import { ArrowDown, ChevronDown } from "lucide-react";
import { useReadContract } from "wagmi";
import { ADDR, arcTestnet, erc20Abi, fmt, parse } from "@/lib/contracts";
import { useSwapQuote } from "@/lib/useSwapQuote";
import { useSigner } from "@/lib/signer";
import { buildApprove, buildSwap } from "@/lib/onyxActions";
import { haptic } from "@/lib/telegram";
import {
  banner, friendlyError, isBusy, txIdle, type TxState,
  initialSwapSteps, setStep, stepForError, type SwapStep,
} from "@/lib/txState";
import { SwapProgressModal } from "./SwapProgressModal";
import { quoterAbi, routerWriteAbi } from "@/lib/contracts";
import { usePublicClient } from "wagmi";
import { REAUTH_THRESHOLD } from "./MiniApp";

/**
 * Swap — the same quote, route split and price-improvement numbers the desktop
 * site shows, because both read from useSwapQuote() rather than each computing
 * their own.
 */
function TokenPill({ sym }: { sym: string }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-[color:var(--line)] bg-white/[0.04] px-2.5 py-1 text-xs font-semibold text-fg">
      <span
        className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white ${
          sym === "USDC" ? "bg-[#2775CA]" : "bg-[#3550c8]"
        }`}
      >
        {sym === "USDC" ? "$" : "€"}
      </span>
      {sym}
    </span>
  );
}

export function SwapTab({ fallbackCap }: { fallbackCap: number | null }) {
  const signer = useSigner();
  const [zeroForOne, setZeroForOne] = useState(true);
  const [amount, setAmount] = useState("1");
  const [tx, setTx] = useState<TxState>(txIdle);
  const [showDetail, setShowDetail] = useState(false);
  const [steps, setSteps] = useState<SwapStep[] | null>(null);
  const client = usePublicClient({ chainId: arcTestnet.id });
  const busy = isBusy(tx);

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

  const { data: outBal } = useReadContract({
    address: (zeroForOne ? ADDR.eurc : ADDR.usdc) as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: signer.address ? [signer.address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: Boolean(signer.address) },
  });

  const balance = (inBal as bigint | undefined) ?? 0n;
  const outBalance = (outBal as bigint | undefined) ?? 0n;
  // Unit price for the "1 USDC ≈ …" line. Derived from the quote so it always
  // agrees with the number above it.
  const unitPrice =
    quote && amountIn > 0n ? Number(quote.expectedOut) / Number(amountIn) : null;
  const insufficient = amountIn > 0n && amountIn > balance;
  const overCap = fallbackCap != null && Number(amount) > fallbackCap;

  async function onSwap() {
    if (!signer.address || !quote || !client) return;
    const owner = signer.address;
    const tokenIn = (zeroForOne ? ADDR.usdc : ADDR.eurc) as `0x${string}`;

    setTx({ status: "signing" });
    setShowDetail(false);
    haptic.confirm();

    let live: SwapStep[] = [];
    const push = (next: SwapStep[]) => {
      live = next;
      setSteps(next);
    };

    try {
      // 2a — only approve when the allowance is actually short. An unconditional
      // approve is a wasted signature, and on tokens that forbid a non-zero
      // rewrite it reverts before the swap is ever attempted.
      const allowance = (await client.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, ADDR.router as `0x${string}`],
      })) as bigint;
      const needsApproval = allowance < amountIn;
      push(initialSwapSteps(needsApproval));

      // 2c — re-quote immediately before submitting. The on-screen quote can be
      // seconds old, and limitTick/bookIn are only valid against the book they
      // were computed from; a stale one reverts as Slippage or WouldCross.
      push(setStep(live, "swap", { state: "active", detail: "Refreshing quote…" }));
      const fresh = (await client.readContract({
        address: ADDR.quoter as `0x${string}`,
        abi: quoterAbi,
        functionName: "quote",
        args: [zeroForOne, amountIn, 16],
      })) as { bookIn: bigint; expectedOut: bigint; limitTick: number };

      if (fresh.expectedOut === 0n) {
        throw new Error("No route available right now — the curve may be paused on a stale rate.");
      }
      // Guard the user against a quote that moved under them while they tapped.
      const drop = Number(((quote.expectedOut - fresh.expectedOut) * 10_000n) / quote.expectedOut);
      if (drop > 100) {
        throw new Error(
          `Price moved ${(drop / 100).toFixed(2)}% while you were confirming. Check the new quote and try again.`,
        );
      }

      const swapReq = {
        ...buildSwap({
          zeroForOne, amountIn,
          bookIn: fresh.bookIn,
          expectedOut: fresh.expectedOut,
          limitTick: Number(fresh.limitTick),
          recipient: owner,
          slippageBps: 50,
        }),
        capValue: Number(amount),
        requiresReauth: Number(amount) > REAUTH_THRESHOLD,
        label: "Submit swap",
      };

      // 2c — simulate before spending gas, so a predictable revert is reported
      // as a reason rather than a failed transaction the user pays for.
      push(setStep(live, "swap", { state: "active", detail: "Checking the trade…" }));
      try {
        await client.simulateContract({
          address: ADDR.router as `0x${string}`,
          abi: routerWriteAbi,
          functionName: "swapExactIn",
          args: swapReq.args as never,
          account: owner,
        });
      } catch (simErr) {
        // Only trust a decoded revert. An RPC hiccup during simulation must not
        // block a swap that would have succeeded.
        const { message } = friendlyError(simErr);
        if (message !== "Swap failed." && !/couldn't reach/i.test(message)) {
          throw new Error(message);
        }
      }

      const reqs = needsApproval
        ? [
            {
              ...buildApprove(tokenIn, ADDR.router as `0x${string}`, amountIn),
              // 2b — the approve must be MINED before the swap is broadcast.
              awaitReceipt: true,
              label: "Approve token",
            },
            swapReq,
          ]
        : [swapReq];

      push(setStep(live, "swap", { state: "pending", detail: undefined }));
      setTx({ status: "broadcasting" });

      const hashes = await signer.writeBatch(reqs, (e) => {
        if (e.phase === "unlocking") push(setStep(live, "unlock", { state: "active" }));
        if (e.phase === "sending") {
          push(setStep(setStep(live, "unlock", { state: "done" }),
            e.label === "Approve token" ? "approve" : "swap", { state: "active" }));
        }
        if (e.phase === "sent") {
          const id = e.label === "Approve token" ? "approve" : "swap";
          push(setStep(live, id, { state: id === "approve" ? "active" : "done", hash: e.hash }));
        }
        if (e.phase === "mined") push(setStep(live, "approve", { state: "done", hash: e.hash }));
      });

      const hash = hashes[hashes.length - 1];
      push(setStep(live, "confirm", { state: "active", detail: "Waiting for the block…" }));
      setTx({ status: "pending", hash });

      const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status === "success") {
        haptic.success();
        push(setStep(live, "confirm", { state: "done", detail: undefined, hash }));
        setTx({ status: "confirmed", hash });
      } else {
        haptic.error();
        push(setStep(live, "confirm", { state: "failed", detail: "Reverted on-chain", hash }));
        setTx({ status: "failed", message: "The swap reverted on-chain.", hash });
      }
    } catch (e) {
      haptic.error();
      const { message, detail } = friendlyError(e);
      const where = stepForError(e);
      if (live.length) push(setStep(live, where, { state: "failed", detail: message }));
      setTx({ status: "failed", message, detail });
    }
  }

  return (
    <div className="space-y-3">
      <div className="inner p-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted">You pay</span>
          <TokenPill sym={inSym} />
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

      {/* The direction toggle sits between the cards as an icon, the way the
          desktop panel does — a text pill reading "USDC → EURC ⇅" was doing the
          job of a button while looking like a label. */}
      <div className="relative -my-1.5 flex justify-center">
        <button
          onClick={() => {
            haptic.select();
            setZeroForOne((v) => !v);
          }}
          aria-label={`Swap direction to ${outSym} → ${inSym}`}
          className="flex h-9 w-9 items-center justify-center rounded-full border border-[color:var(--line)] bg-base text-muted transition-colors active:text-fg"
        >
          <ArrowDown size={15} />
        </button>
      </div>

      <div className="inner p-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted">You receive</span>
          <TokenPill sym={outSym} />
        </div>
        <div className="mt-2 font-mono text-3xl tabular text-fg">
          {quote ? fmt(quote.expectedOut) : "0.0000"}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="font-mono text-[11px] text-faint">bal {fmt(outBalance, 4)}</span>
          {unitPrice !== null && (
            <span className="font-mono text-[10px] text-faint">
              1 {inSym} ≈ {unitPrice.toFixed(4)} {outSym} · incl. 0.02% taker fee
            </span>
          )}
        </div>
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

      {(() => {
        const b = banner(tx);
        if (b.kind === "none") return quoteError ? (
          <p className="rounded-lg border border-rose/30 bg-rose/[0.06] p-3 text-[11px] text-rose">
            {quoteError}
          </p>
        ) : null;
        if (b.kind === "progress")
          return (
            <p className="rounded-lg border border-[color:var(--line)] bg-white/[0.03] p-3 text-[11px] text-muted">
              {b.text}
            </p>
          );
        if (b.kind === "success")
          return (
            <a
              href={`https://testnet.arcscan.app/tx/${b.hash}`}
              target="_blank"
              rel="noreferrer"
              className="block rounded-lg border border-mint/30 bg-mint/[0.06] p-3 text-[11px] text-mint"
            >
              {b.text} — view on Arcscan ↗
            </a>
          );
        return (
          <div className="rounded-lg border border-rose/30 bg-rose/[0.06] p-3">
            <p className="text-[11px] text-rose">{b.text}</p>
            {b.detail && (
              <>
                <button
                  onClick={() => setShowDetail((v) => !v)}
                  className="mt-1.5 flex items-center gap-1 text-[10px] text-rose/80"
                >
                  Details <ChevronDown size={10} className={showDetail ? "rotate-180" : ""} />
                </button>
                {showDetail && (
                  <p className="mt-1.5 break-words font-mono text-[10px] leading-relaxed text-rose/70">
                    {b.detail}
                  </p>
                )}
              </>
            )}
          </div>
        );
      })()}

      {insufficient && (
        <a
          href="/faucet"
          target="_blank"
          rel="noreferrer"
          className="block rounded-lg border border-indigo/40 bg-indigo/[0.10] p-3 text-[11px] text-fg"
        >
          Not enough {inSym}. <span className="text-indigo underline">Get testnet funds →</span>
        </a>
      )}

      {overCap && (
        <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/[0.08] p-3 text-[11px] text-yellow-600">
          Capped at {fallbackCap} USDC while your key is in less-secure storage.
        </p>
      )}

      <SwapProgressModal
        open={steps !== null}
        steps={steps ?? []}
        payAmount={amount}
        paySymbol={inSym}
        receiveAmount={quote ? fmt(quote.expectedOut) : "—"}
        receiveSymbol={outSym}
        dismissable={!busy}
        onClose={() => setSteps(null)}
        onRetry={() => {
          setSteps(null);
          void onSwap();
        }}
      />

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
