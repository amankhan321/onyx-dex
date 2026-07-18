"use client";

import { AnimatePresence, motion } from "framer-motion";
import { Check, Loader2, X } from "lucide-react";
import { fmt } from "@/lib/contracts";

export type SwapStage = "idle" | "approving" | "swapping" | "done" | "error";

/**
 * Confirmation modal for a swap.
 *
 * Deliberately NOT a bridge/relay tracker: an Onyx swap is a single atomic
 * transaction on one chain (USDC<->EURC through the Router). Showing a
 * "Send -> Relay -> Receive on destination chain" flow would tell the user
 * their funds cross a bridge, which they don't. The honest three steps are
 * Approve -> Swap -> Confirmed, all on Arc.
 */
export function SwapModal({
  open,
  stage,
  fromSym,
  toSym,
  amountIn,
  amountOut,
  txHash,
  error,
  onClose,
}: {
  open: boolean;
  stage: SwapStage;
  fromSym: string;
  toSym: string;
  amountIn: bigint;
  amountOut: bigint;
  txHash?: string;
  error?: string;
  onClose: () => void;
}) {
  const steps = [
    { key: "approving", label: `Approve ${fromSym}`, note: "Allow the Router to move your tokens" },
    { key: "swapping", label: "Swap on Arc", note: "Router sweeps the book, then the curve" },
    { key: "done", label: `Receive ${toSym}`, note: "Settled on Arc — sub-second finality" },
  ] as const;

  const order = ["approving", "swapping", "done"];
  const curIdx = stage === "error" ? -1 : order.indexOf(stage);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            className="glass w-full max-w-sm p-6"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-fg">Transaction details</h3>
              <button onClick={onClose} aria-label="Close" className="text-faint hover:text-fg">
                <X size={16} />
              </button>
            </div>

            {/* from -> to summary */}
            <div className="mt-5 flex items-center justify-between rounded-xl border border-[color:var(--line)] bg-white/[0.02] p-3">
              <Side sym={fromSym} amt={amountIn} />
              <div className="mx-2 text-faint">→</div>
              <Side sym={toSym} amt={amountOut} align="right" />
            </div>

            {/* step tracker */}
            <div className="mt-5 space-y-1">
              {steps.map((s, i) => {
                const done = curIdx > i || stage === "done";
                const active = curIdx === i && stage !== "done";
                const errored = stage === "error" && i === Math.max(curIdx, 0);
                return (
                  <div key={s.key} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      <div
                        className={`flex h-7 w-7 items-center justify-center rounded-full border ${
                          done
                            ? "border-mint bg-mint/15 text-mint"
                            : errored
                              ? "border-rose bg-rose/15 text-rose"
                              : active
                                ? "border-indigo bg-indigo/15 text-indigo"
                                : "border-[color:var(--line)]5 text-faint"
                        }`}
                      >
                        {done ? (
                          <Check size={14} />
                        ) : active ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : errored ? (
                          <X size={14} />
                        ) : (
                          <span className="text-[11px]">{i + 1}</span>
                        )}
                      </div>
                      {i < steps.length - 1 && (
                        <div className={`my-1 h-6 w-px ${done ? "bg-mint/40" : "bg-white/10"}`} />
                      )}
                    </div>
                    <div className="pb-2 pt-1">
                      <div className={`text-[13px] ${active || done ? "text-fg" : "text-muted"}`}>
                        {s.label}
                      </div>
                      <div className="text-[11px] text-faint">
                        {active && s.key === "approving"
                          ? "Confirm in wallet…"
                          : active && s.key === "swapping"
                            ? "Confirm in wallet…"
                            : s.note}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {stage === "error" && error && (
              <p className="mt-2 break-words rounded-lg border border-rose/30 bg-rose/[0.06] p-2 font-mono text-[11px] text-rose">
                {error.slice(0, 140)}
              </p>
            )}

            {txHash && (
              <a
                href={`https://testnet.arcscan.app/tx/${txHash}`}
                target="_blank"
                rel="noreferrer"
                className="mt-4 block text-center font-mono text-[11px] text-indigo hover:underline"
              >
                View on ArcScan ↗
              </a>
            )}

            {(stage === "done" || stage === "error") && (
              <button onClick={onClose} className="cta mt-4 w-full bg-indigo/80 py-2.5 text-sm font-medium text-white">
                {stage === "done" ? "Done" : "Close"}
              </button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Side({ sym, amt, align }: { sym: string; amt: bigint; align?: "right" }) {
  return (
    <div className={align === "right" ? "text-right" : ""}>
      <div className={`flex items-center gap-1.5 ${align === "right" ? "justify-end" : ""}`}>
        <span
          className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white ${
            sym === "USDC" ? "bg-[#2775CA]" : "bg-[#3550c8]"
          }`}
        >
          {sym === "USDC" ? "$" : "€"}
        </span>
        <span className="text-xs font-semibold text-fg">{sym}</span>
      </div>
      <div className="mt-1 font-mono text-sm tabular text-fg">{fmt(amt)}</div>
      <div className="text-[10px] text-faint">Arc Testnet</div>
    </div>
  );
}
