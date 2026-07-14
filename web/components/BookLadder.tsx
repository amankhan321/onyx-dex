"use client";

import { AnimatePresence, motion } from "framer-motion";
import { fmt } from "@/lib/contracts";
import { useBook, usePool, type Level } from "@/lib/useBook";

export function BookLadder() {
  const { data: book } = useBook();
  const { data: pool } = usePool();

  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const maxSize = Math.max(
    1,
    ...bids.map((l) => Number(l.size)),
    ...asks.map((l) => Number(l.size)),
  );

  const spread =
    bids[0] && asks[0] ? asks[0].price - bids[0].price : null;

  return (
    <div className="rounded-2xl hairline bg-panel p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-white">Order book</h2>
        <span className="text-[11px] text-muted">USDC / EURC</span>
      </div>

      <div className="mt-4 grid grid-cols-[1fr_auto_auto] gap-x-4 text-[11px] uppercase tracking-[0.14em] text-muted">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Total</span>
      </div>

      {/* asks, worst at the top so best sits against the spread */}
      <div className="mt-2 space-y-[2px]">
        <AnimatePresence initial={false}>
          {[...asks].reverse().map((l) => (
            <Row key={`a${l.tick}`} level={l} side="ask" max={maxSize} />
          ))}
        </AnimatePresence>
        {asks.length === 0 && <Empty>no asks resting</Empty>}
      </div>

      {/* the spread, and where the curve sits inside it */}
      <div className="my-3 flex items-center justify-between rounded-lg bg-[#0B0D10] px-3 py-2 hairline">
        <span className="text-[11px] text-muted">
          {spread !== null ? `spread ${(spread * 1e4).toFixed(1)} bps` : "one-sided"}
        </span>
        {pool && (
          <span className="text-[11px] tabular text-accent">
            curve {pool.ammPrice.toFixed(5)}
          </span>
        )}
      </div>

      <div className="space-y-[2px]">
        <AnimatePresence initial={false}>
          {bids.map((l) => (
            <Row key={`b${l.tick}`} level={l} side="bid" max={maxSize} />
          ))}
        </AnimatePresence>
        {bids.length === 0 && <Empty>no bids resting</Empty>}
      </div>
    </div>
  );
}

function Row({
  level,
  side,
  max,
}: {
  level: Level;
  side: "bid" | "ask";
  max: number;
}) {
  const pct = (Number(level.size) / max) * 100;
  const tone = side === "bid" ? "text-bid" : "text-ask";
  const bar = side === "bid" ? "bg-bid/10" : "bg-ask/10";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: side === "bid" ? -6 : 6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
      className="relative grid grid-cols-[1fr_auto_auto] gap-x-4 px-2 py-[5px] text-xs tabular"
    >
      <motion.div
        layout
        className={`absolute inset-y-0 right-0 rounded ${bar}`}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ type: "spring", stiffness: 140, damping: 20 }}
      />
      <span className={`relative ${tone}`}>{level.price.toFixed(5)}</span>
      <span className="relative text-right text-soft">{fmt(level.size, 2)}</span>
      <span className="relative text-right text-muted">
        {(Number(level.size) / 1e6 * level.price).toFixed(2)}
      </span>
    </motion.div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-3 text-center text-[11px] text-[#3A3F49]">
      {children}
    </div>
  );
}
