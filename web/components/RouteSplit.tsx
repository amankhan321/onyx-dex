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

/**
 * The whole thesis, in one component: an order arriving and splitting itself
 * across two venues that price differently.
 *
 * Every other DEX on Arc can only draw the right-hand bar.
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
    <div className="mt-5 rounded-xl hairline bg-[#0B0D10] p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.14em] text-muted">
          Route
        </span>
        {edge !== null && edge > 0.001 && (
          <motion.span
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-[11px] font-medium text-bid tabular"
          >
            +{edge.toFixed(2)}% vs AMM alone
          </motion.span>
        )}
      </div>

      {/* the split bar */}
      <div className="flex h-2 w-full gap-[3px] overflow-hidden rounded-full bg-[#15181D]">
        {bookPct > 0 && (
          <motion.div
            layout
            initial={{ width: 0 }}
            animate={{ width: `${bookPct}%` }}
            transition={{ type: "spring", stiffness: 160, damping: 22 }}
            className="h-full rounded-full bg-bid"
          />
        )}
        {ammPct > 0 && (
          <motion.div
            layout
            initial={{ width: 0 }}
            animate={{ width: `${ammPct}%` }}
            transition={{ type: "spring", stiffness: 160, damping: 22 }}
            className="h-full rounded-full bg-accent"
          />
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Leg
          label="Order book"
          tone="bid"
          share={bookPct}
          inAmt={quote.bookIn}
          outAmt={quote.bookOut}
          outSymbol={outSymbol}
        />
        <Leg
          label="StableSwap"
          tone="accent"
          share={ammPct}
          inAmt={quote.ammIn}
          outAmt={quote.ammOut}
          outSymbol={outSymbol}
        />
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
  tone: "bid" | "accent";
  share: number;
  inAmt: bigint;
  outAmt: bigint;
  outSymbol: string;
}) {
  const dot = tone === "bid" ? "bg-bid" : "bg-accent";
  const dim = share < 0.5;

  return (
    <motion.div
      animate={{ opacity: dim ? 0.35 : 1 }}
      className="rounded-lg bg-[#0E1013] p-3 hairline"
    >
      <div className="flex items-center gap-2">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
        <span className="text-xs text-soft">{label}</span>
        <span className="ml-auto text-xs tabular text-muted">
          {share.toFixed(0)}%
        </span>
      </div>
      <div className="mt-2 text-sm tabular text-white">
        {fmt(outAmt)} <span className="text-xs text-muted">{outSymbol}</span>
      </div>
      <div className="text-[11px] tabular text-muted">
        from {fmt(inAmt)} in
      </div>
    </motion.div>
  );
}
