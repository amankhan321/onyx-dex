"use client";

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { ADDR, arcTestnet, poolAbi, quoterAbi } from "./contracts";
import { STALE_RATE_SELECTOR } from "./rateKeeper";
import { STALE_ROUTE_MINIAPP, STALE_SWAP_SHORT } from "./bot/quote";

/**
 * Swap quoting, lifted out of the site's Swap component so the Mini App shows
 * the SAME numbers rather than a second implementation that slowly disagrees.
 *
 * Behaviour preserved from the original: quoter and AMM baseline fetched in one
 * multicall, 350ms debounce, and a transient RPC blip keeps the last good quote
 * on screen instead of flashing an error.
 */
export type Quote = {
  bookIn: bigint;
  ammIn: bigint;
  expectedOut: bigint;
  bookOut: bigint;
  ammOut: bigint;
  limitTick: number;
};

export function useSwapQuote(zeroForOne: boolean, amountIn: bigint) {
  const client = usePublicClient({ chainId: arcTestnet.id });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [ammOnly, setAmmOnly] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    if (!client || amountIn === 0n) {
      setQuote(null);
      setAmmOnly(null);
      setError(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const [q, a] = (await client.multicall({
          allowFailure: false,
          contracts: [
            {
              address: ADDR.quoter as `0x${string}`,
              abi: quoterAbi,
              functionName: "quote",
              args: [zeroForOne, amountIn, 16],
            },
            {
              address: ADDR.pool as `0x${string}`,
              abi: poolAbi,
              functionName: "getDy",
              args: [zeroForOne, amountIn],
            },
          ],
        })) as [unknown, bigint];
        if (stale) return;
        const r = q as Quote;
        setQuote({ ...r, limitTick: Number(r.limitTick) });
        setAmmOnly(a);
        setError(null);
      } catch (e) {
        if (stale) return;
        // Keep the last good quote through a blip; only surface an error when
        // there is nothing to show.
        setQuote((prev) => {
          if (!prev) {
            const m = e instanceof Error ? e.message : "quote failed";
            setError(
              m.includes(STALE_RATE_SELECTOR)
                ? `${STALE_SWAP_SHORT}. ${STALE_ROUTE_MINIAPP}`
                : "Couldn't fetch a quote. Retrying…",
            );
          }
          return prev;
        });
      }
    }, 350);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [client, amountIn, zeroForOne]);

  const improvementBps =
    quote && ammOnly && ammOnly > 0n
      ? Number(((quote.expectedOut - ammOnly) * 10_000n) / ammOnly)
      : 0;
  const bookShare =
    quote && amountIn > 0n ? Number((quote.bookIn * 10_000n) / amountIn) / 10_000 : 0;

  return { quote, ammOnly, error, improvementBps: Math.max(0, improvementBps), bookShare };
}
