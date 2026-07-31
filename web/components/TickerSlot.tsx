"use client";

import { usePathname } from "next/navigation";
import { Ticker } from "./Ticker";

/**
 * Chooses the tape for the surface.
 *
 * The Mini App is a phone inside Telegram: it gets the Onyx price and
 * provenance only. The full BTC/ETH/FX tape belongs on the marketing pages,
 * where the space exists and the reference prices are part of the pitch.
 */
export function TickerSlot() {
  const pathname = usePathname();
  return <Ticker compact={pathname?.startsWith("/miniapp") ?? false} />;
}
