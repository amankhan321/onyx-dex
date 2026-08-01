"use client";

import { useEffect, useState } from "react";
import { TAPE_SOURCES, fetchFirst } from "./fxFeeds";

/**
 * Reference market rates for the tape.
 *
 * These are REFERENCE prices from public feeds — they are not tradeable on Onyx
 * and never were. Onyx trades USDC/EURC only.
 *
 * NO SYNTHETIC MOVEMENT. A previous version nudged each price by
 * `anchor * (Math.random() - 0.5) * 0.0004` every 2.5 seconds so the tape
 * "felt alive", which meant the numbers on screen and the up/down arrows were
 * invented — a fetch happened once, then five minutes of fiction. State here
 * changes only when a real fetch returns. If a feed is down the pair shows an
 * em dash, never a fabricated number and never zero.
 */

export type Tick = {
  pair: string;
  /** null when the feed is unavailable — render an em dash, never 0. */
  price: number | null;
  /** The previous REAL price, so the arrow reflects an actual move. */
  prev: number | null;
  kind: "crypto" | "fx";
};

const CRYPTO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd";

const CRYPTO_INTERVAL = 60_000; // 1 min
const FX_INTERVAL = 600_000; // 10 min — ECB reference rates update daily

/** Formatting per instrument. 4-decimal BTC is invented precision. */
export function formatPrice(pair: string, price: number | null): string {
  if (price === null || !Number.isFinite(price)) return "—";
  if (pair.startsWith("BTC") || pair.startsWith("ETH")) {
    return price.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (pair.includes("JPY")) return price.toFixed(2);
  return price.toFixed(4);
}

/** Neutral when unchanged — forcing a direction would be another small lie. */
export function direction(t: Tick): "up" | "down" | "flat" {
  if (t.price === null || t.prev === null || t.price === t.prev) return "flat";
  return t.price > t.prev ? "up" : "down";
}

async function fetchFx(): Promise<Record<string, number>> {
  const { value } = await fetchFirst(TAPE_SOURCES, (json) => {
    const r = (json as { rates?: Record<string, number> })?.rates;
    if (!r) return null;
    const out: Record<string, number> = {};
    // Quote the way traders read them, not the way the API returns them.
    if (Number.isFinite(r.EUR) && r.EUR > 0) out["EUR/USD"] = 1 / r.EUR;
    if (Number.isFinite(r.GBP) && r.GBP > 0) out["GBP/USD"] = 1 / r.GBP;
    if (Number.isFinite(r.JPY)) out["USD/JPY"] = r.JPY;
    return Object.keys(out).length > 0 ? out : null;
  });
  return value;
}

async function fetchCrypto(): Promise<Record<string, number>> {
  const res = await fetch(CRYPTO_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()) as { bitcoin?: { usd: number }; ethereum?: { usd: number } };
  const out: Record<string, number> = {};
  if (Number.isFinite(j?.bitcoin?.usd)) out["BTC/USD"] = j!.bitcoin!.usd;
  if (Number.isFinite(j?.ethereum?.usd)) out["ETH/USD"] = j!.ethereum!.usd;
  if (Object.keys(out).length === 0) throw new Error("no usable prices");
  return out;
}

const PAIRS: { pair: string; kind: "crypto" | "fx" }[] = [
  { pair: "BTC/USD", kind: "crypto" },
  { pair: "ETH/USD", kind: "crypto" },
  { pair: "EUR/USD", kind: "fx" },
  { pair: "GBP/USD", kind: "fx" },
  { pair: "USD/JPY", kind: "fx" },
];

export type TickerState = {
  ticks: Tick[];
  /** When each source last returned successfully. null = never, this session. */
  cryptoAt: number | null;
  fxAt: number | null;
};

/** Merge a fetch result in, carrying the previous REAL price into `prev`. */
export function applyUpdate(ticks: Tick[], fresh: Record<string, number>): Tick[] {
  return ticks.map((t) => {
    const next = fresh[t.pair];
    if (next === undefined || !Number.isFinite(next)) return t;
    // Only advance prev when the value actually moved, so the arrow doesn't
    // reset to flat on every identical poll.
    return { ...t, prev: next === t.price ? t.prev : t.price, price: next };
  });
}

export function useTicker(): TickerState {
  const [state, setState] = useState<TickerState>({
    ticks: PAIRS.map((p) => ({ ...p, price: null, prev: null })),
    cryptoAt: null,
    fxAt: null,
  });

  useEffect(() => {
    let alive = true;

    const pull = async (which: "crypto" | "fx" | "both") => {
      // allSettled so one dead feed never takes the other down with it.
      const [crypto, fx] = await Promise.allSettled([
        which === "fx" ? Promise.reject(new Error("skip")) : fetchCrypto(),
        which === "crypto" ? Promise.reject(new Error("skip")) : fetchFx(),
      ]);
      if (!alive) return;

      setState((s) => {
        let ticks = s.ticks;
        let { cryptoAt, fxAt } = s;
        if (crypto.status === "fulfilled") {
          ticks = applyUpdate(ticks, crypto.value);
          cryptoAt = Date.now();
        }
        if (fx.status === "fulfilled") {
          ticks = applyUpdate(ticks, fx.value);
          fxAt = Date.now();
        }
        return { ticks, cryptoAt, fxAt };
      });
    };

    void pull("both");
    const c = setInterval(() => void pull("crypto"), CRYPTO_INTERVAL);
    const f = setInterval(() => void pull("fx"), FX_INTERVAL);
    return () => {
      alive = false;
      clearInterval(c);
      clearInterval(f);
    };
  }, []);

  return state;
}

export function formatAgo(at: number | null, now = Date.now()): string {
  if (at === null) return "never";
  const s = Math.round((now - at) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
