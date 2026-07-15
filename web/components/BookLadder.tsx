"use client";

import { AnimatePresence, motion } from "framer-motion";
import { fmt } from "@/lib/contracts";
import { useBook, usePool, type Level } from "@/lib/useBook";

const EASE = [0.16, 1, 0.3, 1] as const;

export function BookLadder({ onMake }: { onMake?: () => void } = {}) {
  const { data: book } = useBook();
  const { data: pool } = usePool();

  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const max = Math.max(1, ...bids.map((l) => Number(l.size)), ...asks.map((l) => Number(l.size)));
  const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : null;

  return (
    <div className="glass lift h-full overflow-x-auto p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-fg">Order book</h2>
        <span className="font-mono text-[11px] text-faint">USDC / EURC</span>
      </div>

      <div className="mt-5 grid grid-cols-[1fr_auto_auto] gap-x-5 px-2 text-[10px] uppercase tracking-[0.14em] text-faint">
        <span>Price</span>
        <span className="text-right">Size</span>
        <span className="text-right">Value</span>
      </div>

      <div className="mt-2 space-y-[1px]">
        <AnimatePresence initial={false}>
          {[...asks].reverse().map((l) => (
            <Row key={`a${l.tick}`} level={l} side="ask" max={max} />
          ))}
        </AnimatePresence>
        {asks.length === 0 && <Empty>no asks resting</Empty>}
      </div>

      <div className="my-3 flex items-center justify-between rounded-[12px] border border-white/[0.08] bg-white/[0.025] px-3 py-2">
        <span className="font-mono text-[11px] text-faint">
          {spread !== null ? `spread ${(spread * 1e4).toFixed(1)} bps` : "one-sided"}
        </span>
        {pool && (
          <span className="font-mono text-[11px] tabular text-indigo">
            curve {pool.ammPrice.toFixed(5)}
          </span>
        )}
      </div>

      <div className="space-y-[1px]">
        <AnimatePresence initial={false}>
          {bids.map((l) => (
            <Row key={`b${l.tick}`} level={l} side="bid" max={max} />
          ))}
        </AnimatePresence>
        {bids.length === 0 && (
          <div className="px-2 py-4 text-center">
            <div className="font-mono text-[11px] text-faint">no bids resting</div>
            {onMake && (
              <button
                onClick={onMake}
                className="btn mt-3 border border-indigo/40 px-4 py-1.5 text-xs text-indigo hover:bg-indigo/10"
              >
                Be the first maker — post an order
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ level, side, max }: { level: Level; side: "bid" | "ask"; max: number }) {
  const pct = (Number(level.size) / max) * 100;
  const tone = side === "bid" ? "text-mint" : "text-rose";
  const depth = side === "bid" ? "bg-mint/[0.09]" : "bg-rose/[0.09]";

  return (
    <motion.div
      layout
      initial={{ opacity: 0, x: side === "bid" ? -6 : 6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22, ease: EASE }}
      className={`row row-${side} grid cursor-default grid-cols-[1fr_auto_auto] gap-x-5 rounded-[6px] px-2 py-[6px] font-mono text-xs tabular`}
    >
      <motion.div
        layout
        className={`absolute inset-y-0 right-0 rounded-[6px] ${depth}`}
        initial={{ width: 0 }}
        animate={{ width: `${pct}%` }}
        transition={{ type: "spring", stiffness: 130, damping: 22 }}
      />
      <span className={`relative ${tone}`}>{level.price.toFixed(5)}</span>
      <span className="relative text-right text-muted">{fmt(level.size, 2)}</span>
      <span className="relative text-right text-faint">
        {((Number(level.size) / 1e6) * level.price).toFixed(2)}
      </span>
    </motion.div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-4 text-center font-mono text-[11px] text-faint">
      {children}
    </div>
  );
}
