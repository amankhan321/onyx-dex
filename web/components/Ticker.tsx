"use client";

import { useTicker } from "@/lib/ticker";
import { usePool } from "@/lib/useBook";

/**
 * The moving tape across the top. Labelled MARKET, hard left, so it is
 * unambiguous that these are reference rates and not ArcBook's book.
 */
export function Ticker() {
  const ticks = useTicker();
  const { data: pool } = usePool(8000);
  const decimals = (p: string) => (p.includes("JPY") ? 2 : 4);

  return (
    <div className="relative z-20 flex items-center gap-4 border-b border-[color:var(--line)] bg-black/40 px-4 py-3 backdrop-blur-xl">
      <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-amber-400/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-amber-400/90">
        <span className="h-1 w-1 animate-pulse rounded-full bg-amber-400" />
        Market
      </span>

      <div className="flex flex-1 items-center gap-6 overflow-x-auto scrollbar-none">
        {pool && (
          <div className="flex shrink-0 items-baseline gap-2">
            <span className="rounded bg-indigo/20 px-1.5 py-[1px] font-mono text-[9px] font-medium uppercase tracking-wider text-indigo">
              ArcBook
            </span>
            <span className="font-mono text-[13px] text-muted">USDC/EURC</span>
            <span className="font-mono text-[13px] tabular text-fg">
              {pool.ammPrice.toFixed(5)}
            </span>
          </div>
        )}
        {ticks.filter((t) => t.price > 0).map((t) => {
          const up = t.price >= t.prev;
          const isCrypto = t.pair === "BTC/USD" || t.pair === "ETH/USD";
          const shown = isCrypto
            ? t.price.toLocaleString("en-US", { maximumFractionDigits: 0 })
            : t.price.toFixed(decimals(t.pair));
          return (
            <div key={t.pair} className="flex shrink-0 items-baseline gap-2">
              <span className="font-mono text-[13px] text-muted">{t.pair}</span>
              <span
                className={`font-mono text-[13px] tabular tabular-nums transition-colors duration-500 ${
                  up ? "text-mint" : "text-rose"
                }`}
              >
                {t.price ? t.price.toFixed(decimals(t.pair)) : "—"}
              </span>
              <span className={`text-[9px] ${up ? "text-mint" : "text-rose"}`}>
                {t.price ? (up ? "▲" : "▼") : ""}
              </span>
            </div>
          );
        })}
      </div>

      <span className="hidden shrink-0 font-mono text-[9px] text-faint sm:block">
        reference · not tradable here
      </span>
    </div>
  );
}
