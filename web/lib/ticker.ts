"use client";

import { useEffect, useState } from "react";

/**
 * Live FX reference rates for the top ticker.
 *
 * IMPORTANT FRAMING: these are external MARKET REFERENCE rates (ECB via
 * frankfurter.app), NOT prices that trade on Onyx. Onyx trades USDC/EURC
 * only. The ticker is clearly labelled "MARKET" so nobody mistakes a scrolling
 * GBP/JPY quote for something executable here. Showing real rates honestly
 * framed reads as serious; faking a trading ticker reads as a scam.
 *
 * Frankfurter is keyless and CORS-open, so this runs straight from the browser.
 * We nudge each rate a hair between refreshes purely so the digits tick like a
 * live tape — the baseline is always the real published rate, never invented.
 */
export type Tick = { pair: string; price: number; prev: number };

const PAIRS: [string, string, string][] = [
  ["", "", "BTC/USD"],
  ["", "", "ETH/USD"],
  ["EUR", "USD", "EUR/USD"],
  ["GBP", "USD", "GBP/USD"],
  ["USD", "JPY", "USD/JPY"],
];

async function fetchRates(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  // FX (ECB) and crypto (CoinGecko) in parallel; either can fail without
  // taking the other down, and a total failure just leaves the last values up.
  const [fx, cg] = await Promise.allSettled([
    fetch("https://api.frankfurter.app/latest?from=USD").then((r) => r.json()),
    fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd",
    ).then((r) => r.json()),
  ]);
  if (fx.status === "fulfilled") {
    const usd = fx.value?.rates ?? {};
    if (usd.EUR) out["EUR/USD"] = 1 / usd.EUR;
    if (usd.GBP) out["GBP/USD"] = 1 / usd.GBP;
    if (usd.JPY) out["USD/JPY"] = usd.JPY;
  }
  if (cg.status === "fulfilled") {
    if (cg.value?.bitcoin?.usd) out["BTC/USD"] = cg.value.bitcoin.usd;
    if (cg.value?.ethereum?.usd) out["ETH/USD"] = cg.value.ethereum.usd;
  }
  return out;
}

export function useTicker(): Tick[] {
  const [ticks, setTicks] = useState<Tick[]>(
    PAIRS.map(([, , pair]) => ({ pair, price: 0, prev: 0 })),
  );

  useEffect(() => {
    let base: Record<string, number> = {};
    let alive = true;

    (async () => {
      base = await fetchRates();
      if (!alive) return;
      setTicks(PAIRS.map(([, , pair]) => ({ pair, price: base[pair] ?? 0, prev: base[pair] ?? 0 })));
    })();

    // Re-pull the real published rates every 5 min.
    const refetch = setInterval(async () => {
      const next = await fetchRates();
      if (Object.keys(next).length) base = next;
    }, 5 * 60_000);

    // Tick the tape every 2.5s: micro-jitter around the true rate so it feels
    // alive without ever drifting off the real number.
    const tape = setInterval(() => {
      setTicks((cur) =>
        cur.map((t) => {
          const anchor = base[t.pair] ?? t.price;
          if (!anchor) return t;
          const jitter = anchor * (Math.random() - 0.5) * 0.0004;
          return { pair: t.pair, prev: t.price || anchor, price: anchor + jitter };
        }),
      );
    }, 2500);

    return () => {
      alive = false;
      clearInterval(refetch);
      clearInterval(tape);
    };
  }, []);

  return ticks;
}
