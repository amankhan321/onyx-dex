"use client";

import { AlertCircle, ArrowRight, Check, ExternalLink, Loader2, X } from "lucide-react";
import type { SwapStep } from "@/lib/txState";

/**
 * Swap progress, modelled on Relay's Transaction Details sheet but adapted for
 * a wallet that signs locally.
 *
 * The difference that matters: there is NO "confirm in your wallet" step. The
 * Mini App holds the key and asks for the password once, so rendering a
 * wallet-approval step would tell the user to go and do something that does not
 * exist. Step 1 is "Unlock wallet", and it covers the password prompt and the
 * key derivation.
 *
 * The point of the whole component is that a failure names WHERE it happened.
 * "Swap failed." with no location is what this replaces.
 */
export function SwapProgressModal({
  open,
  steps,
  payAmount,
  paySymbol,
  receiveAmount,
  receiveSymbol,
  dismissable,
  onClose,
  onRetry,
}: {
  open: boolean;
  steps: SwapStep[];
  payAmount: string;
  paySymbol: string;
  receiveAmount: string;
  receiveSymbol: string;
  /** False while a key is unlocked or a transaction is in flight. */
  dismissable: boolean;
  onClose: () => void;
  onRetry?: () => void;
}) {
  if (!open) return null;

  const failed = steps.find((s) => s.state === "failed");
  const allDone = steps.every((s) => s.state === "done" || s.state === "skipped");

  return (
    <div
      className="fixed inset-0 z-[150] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center"
      onClick={dismissable ? onClose : undefined}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass w-full max-w-sm p-5 motion-safe:animate-[fadeIn_.2s_ease-out]"
      >
        <div className="flex items-start justify-between">
          <h2 className="text-sm font-medium text-fg">Swap</h2>
          {dismissable && (
            <button onClick={onClose} aria-label="Close" className="text-faint hover:text-fg">
              <X size={15} />
            </button>
          )}
        </div>

        {/* From → to, mirroring the two cards above it. */}
        <div className="mt-4 flex items-center justify-between rounded-xl border border-[color:var(--line)] bg-white/[0.03] p-3">
          <div>
            <div className="font-mono text-sm tabular text-fg">{payAmount}</div>
            <div className="text-[10px] text-faint">{paySymbol}</div>
          </div>
          <ArrowRight size={14} className="mx-2 shrink-0 text-faint" />
          <div className="text-right">
            <div className="font-mono text-sm tabular text-fg">{receiveAmount}</div>
            <div className="text-[10px] text-faint">{receiveSymbol}</div>
          </div>
        </div>

        <ol className="mt-4 space-y-0">
          {steps.map((s, i) => (
            <li key={s.id} className="flex gap-3">
              <div className="flex flex-col items-center">
                <StepIcon state={s.state} index={i + 1} />
                {i < steps.length - 1 && (
                  <div
                    className={`my-1 w-px flex-1 ${
                      s.state === "done" || s.state === "skipped" ? "bg-mint/40" : "bg-white/10"
                    }`}
                    style={{ minHeight: 14 }}
                  />
                )}
              </div>
              <div className="flex-1 pb-3">
                <div
                  className={`text-[13px] ${
                    s.state === "pending" ? "text-faint" : "text-fg"
                  }`}
                >
                  {s.label}
                  {s.state === "skipped" && (
                    <span className="ml-1.5 text-[10px] text-faint">not needed</span>
                  )}
                </div>
                {s.detail && (
                  <div
                    className={`mt-0.5 text-[11px] leading-relaxed ${
                      s.state === "failed" ? "text-rose" : "text-faint"
                    }`}
                  >
                    {s.detail}
                  </div>
                )}
                {s.hash && (
                  <a
                    href={`https://testnet.arcscan.app/tx/${s.hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 font-mono text-[10px] text-indigo"
                  >
                    {s.hash.slice(0, 10)}… <ExternalLink size={9} />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>

        {failed && onRetry && (
          <button
            onClick={onRetry}
            className="mt-1 min-h-[44px] w-full rounded-full bg-indigo text-sm font-semibold text-white"
          >
            Try again
          </button>
        )}
        {allDone && dismissable && (
          <button
            onClick={onClose}
            className="mt-1 min-h-[44px] w-full rounded-full bg-indigo text-sm font-semibold text-white"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}

function StepIcon({ state, index }: { state: SwapStep["state"]; index: number }) {
  const base = "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px]";
  if (state === "done") return <div className={`${base} border-mint bg-mint/15 text-mint`}><Check size={12} /></div>;
  if (state === "skipped") return <div className={`${base} border-[color:var(--line)] text-faint`}>—</div>;
  if (state === "active")
    return (
      <div className={`${base} border-indigo bg-indigo/15 text-indigo`}>
        <Loader2 size={12} className="motion-safe:animate-spin" />
      </div>
    );
  if (state === "failed") return <div className={`${base} border-rose bg-rose/15 text-rose`}><AlertCircle size={12} /></div>;
  return <div className={`${base} border-[color:var(--line)] text-faint`}>{index}</div>;
}
