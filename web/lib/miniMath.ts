/**
 * Pure helpers for the Mini App panels.
 *
 * Deliberately outside the component files: this is the logic most worth
 * testing, and it shouldn't require a React or wagmi runtime to exercise.
 */

/** twaps(id) returns a POSITIONAL tuple, not a named object. */
export type TwapTuple = [string, boolean, boolean, number, number, bigint, bigint, bigint, bigint];

export type TwapPosition = {
  id: bigint;
  zeroForOne: boolean;
  interval: number;
  slicesLeft: number;
  remaining: bigint;
  nextExecAt: number;
};

/** Keep only live TWAPs belonging to this wallet. */
export function filterOwnedActive(
  rows: { id: bigint; tuple: TwapTuple }[],
  wallet: string,
): TwapPosition[] {
  const me = wallet.toLowerCase();
  return rows
    .filter(({ tuple }) => tuple[0]?.toLowerCase() === me && tuple[2] === true)
    .map(({ id, tuple }) => ({
      id,
      zeroForOne: tuple[1],
      interval: Number(tuple[3]),
      slicesLeft: Number(tuple[4]),
      remaining: tuple[6],
      nextExecAt: Number(tuple[7]),
    }));
}

/** "in 2m" / "due now" — relative reads better than a timestamp here. */
export function relativeTime(unixSeconds: number, nowMs = Date.now()): string {
  const delta = unixSeconds * 1000 - nowMs;
  if (delta <= 0) return "due now";
  const mins = Math.round(delta / 60_000);
  if (mins < 1) return "in <1m";
  if (mins < 60) return `in ${mins}m`;
  return `in ${Math.round(mins / 60)}h`;
}

/**
 * Share of pool and LP value.
 *
 * virtualPrice is 1e18-scaled while LP and reserves are 6-dec. Mixing those is
 * the easiest way to be wrong by a factor of a trillion on this chain, so the
 * conversion happens in exactly one place.
 */
export function lpMetrics(lp: bigint, supply: bigint, virtualPrice: bigint) {
  if (supply === 0n) return { share: 0, value: 0 };
  const share = Number((lp * 1_000_000n) / supply) / 1_000_000;
  const value = (Number(lp) / 1e6) * (Number(virtualPrice) / 1e18);
  return { share, value };
}

/**
 * Total holdings in USDC terms. `rate` is EURC per USDC; null when the FX
 * oracle is stale, in which case there is no honest conversion to show.
 */
export function totalValueUsdc(usdc: bigint, eurc: bigint, rate: number | null): number | null {
  if (rate === null || rate <= 0) return null;
  return Number(usdc) / 1e6 + Number(eurc) / 1e6 / rate;
}
