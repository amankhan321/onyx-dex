"use client";

import { useEffect, useState } from "react";
import { usePool } from "@/lib/useBook";
import { BotDock } from "./BotDock";
import { direction, formatAgo, formatPrice, useTicker } from "@/lib/ticker";

/**
 * Reference tape.
 *
 * Every number here comes from a real fetch. Nothing animates between fetches —
 * an earlier version jittered the prices so the tape looked alive, which meant
 * the movement and the arrows were fabricated. A feed that is down shows an em
 * dash and says so on hover, rather than disappearing or showing zero.
 */
export function Ticker() {
  const { data: pool } = usePool();
  const { ticks, cryptoAt, fxAt } = useTicker();
  const [, force] = useState(0);

  // Re-render once a minute so the "last updated" ages visibly.
  useEffect(() => {
    const id = setInterval(() => force((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const oldest =
    cryptoAt === null || fxAt === null ? (cryptoAt ?? fxAt) : Math.min(cryptoAt, fxAt);

  return (
    <div className="relative z-20 flex items-center gap-4 ticker-rail px-4 py-3 backdrop-blur-xl">
      <span className="flex shrink-0 items-center gap-1.5 rounded-md bg-amber-500/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-amber-500">
        <span className="h-1 w-1 rounded-full bg-amber-500" />
        Market
      </span>

      <BotDock />

      {/* Provenance: whose numbers these are and how old. */}
      <span
        className="hidden shrink-0 font-mono text-[10px] text-faint sm:inline"
        title="Reference rates from the ECB (via Frankfurter) and CoinGecko. Not tradeable on Onyx."
      >
        ECB · CoinGecko · {formatAgo(oldest)}
      </span>

      <div className="scrollbar-none flex items-center gap-5 overflow-x-auto text-[13px]">
        <span className="shrink-0 rounded-md bg-indigo/15 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-indigo">
          Onyx
        </span>
        <span className="shrink-0 font-mono tabular">
          <span className="text-faint">USDC/EURC</span>{" "}
          <span className="text-fg">
            {pool?.ammPrice ? pool.ammPrice.toFixed(5) : "—"}
          </span>
        </span>

        {ticks.map((t) => {
          const dir = direction(t);
          const unavailable = t.price === null;
          return (
            <span
              key={t.pair}
              className="shrink-0 font-mono tabular"
              title={unavailable ? "reference feed unavailable" : undefined}
            >
              <span className="text-faint">{t.pair}</span>{" "}
              <span
                className={
                  unavailable
                    ? "text-faint"
                    : dir === "up"
                      ? "text-mint"
                      : dir === "down"
                        ? "text-rose"
                        : "text-muted"
                }
              >
                {formatPrice(t.pair, t.price)}
                {dir === "up" && " ▲"}
                {dir === "down" && " ▼"}
              </span>
            </span>
          );
        })}
      </div>

      <span className="ml-auto hidden shrink-0 font-mono text-[10px] text-faint lg:inline">
        reference · not tradable here
      </span>
    </div>
  );
}
