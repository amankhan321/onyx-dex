"use client";

import { motion } from "framer-motion";
import { fmt } from "@/lib/contracts";

export type Quote = {
  bookIn: bigint;
  ammIn: bigint;
  expectedOut: bigint;
  bookOut: bigint;
  ammOut: bigint;
  limitTick: number;
};

const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * The whole thesis in one component: an order arriving and splitting itself
 * across two venues that price differently.
 *
 * The right-hand bar is what a curve-only route would fill on its own.
 */
export function RouteSplit({
  quote,
  amountIn,
  ammOnly,
  outSymbol,
}: {
  quote: Quote;
  amountIn: bigint;
  ammOnly?: bigint;
  outSymbol: string;
}) {
  const total = Number(amountIn) || 1;
  const bookPct = (Number(quote.bookIn) / total) * 100;
  const ammPct = (Number(quote.ammIn) / total) * 100;

  const edge =
    ammOnly && ammOnly > 0n
      ? (Number(quote.expectedOut) / Number(ammOnly) - 1) * 100
      : null;

  return (
    <div className="inner mt-5 p-4">
      <div className="mb-3.5 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.14em] text-faint">
          Route
        </span>
        {edge !== null && edge > 0.001 && (
          <motion.span
            key={edge.toFixed(2)}
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="font-mono text-[11px] font-medium tabular text-mint"
          >
            +{edge.toFixed(2)}% vs curve-only, this quote
          </motion.span>
        )}
      </div>

      <div className="flex h-2 w-full gap-[3px] overflow-hidden rounded-full bg-white/[0.06]">
        <motion.div
          className="h-full rounded-full bg-mint"
          animate={{ width: `${bookPct}%` }}
          transition={{ type: "spring", stiffness: 130, damping: 24 }}
          style={{ boxShadow: bookPct > 0 ? "0 0 12px rgba(46,211,167,0.5)" : "none" }}
        />
        <motion.div
          className="h-full rounded-full bg-indigo"
          animate={{ width: `${ammPct}%` }}
          transition={{ type: "spring", stiffness: 130, damping: 24 }}
          style={{ boxShadow: ammPct > 0 ? "0 0 12px rgba(94,106,210,0.5)" : "none" }}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Leg label="Order book" tone="mint" share={bookPct} inAmt={quote.bookIn} outAmt={quote.bookOut} outSymbol={outSymbol} />
        <Leg label="StableSwap" tone="indigo" share={ammPct} inAmt={quote.ammIn} outAmt={quote.ammOut} outSymbol={outSymbol} />
      </div>
    </div>
  );
}

function Leg({
  label,
  tone,
  share,
  inAmt,
  outAmt,
  outSymbol,
}: {
  label: string;
  tone: "mint" | "indigo";
  share: number;
  inAmt: bigint;
  outAmt: bigint;
  outSymbol: string;
}) {
  const dot = tone === "mint" ? "bg-mint" : "bg-indigo";
  return (
    <motion.div
      animate={{ opacity: share < 0.5 ? 0.6 : 1 }}
      transition={{ duration: 0.4, ease: EASE }}
      className="rounded-[12px] border border-white/[0.07] bg-white/[0.02] p-3"
    >
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="text-xs text-muted">{label}</span>
        <span className="ml-auto font-mono text-xs tabular text-faint">
          {share.toFixed(0)}%
        </span>
      </div>
      <div className="mt-2 font-mono text-sm tabular text-fg">
        {fmt(outAmt)} <span className="text-[10px] text-faint">{outSymbol}</span>
      </div>
      <div className="font-mono text-[10px] tabular text-faint">
        from {fmt(inAmt)} in
      </div>
    </motion.div>
  );
}
