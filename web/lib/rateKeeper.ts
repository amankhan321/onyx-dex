/**
 * FX rate keeper — decision logic.
 *
 * Pure and dependency-free so it can be unit-tested without a chain or a
 * network. The script is a thin shell around these functions.
 *
 * Mirrors GuardedRateProvider's guards exactly. Getting any of these wrong
 * means a reverted transaction and a rate that keeps aging toward the halt:
 *   MIN_UPDATE_INTERVAL  300s   — setRate reverts TooSoon below this
 *   MAX_DEVIATION_BPS    100    — 1% max move per update, else DeviationTooLarge
 *   STALENESS_WINDOW     21600s — getRate() reverts StaleRate beyond this
 */

export const MIN_UPDATE_INTERVAL = 300;
export const STALENESS_WINDOW = 21_600;
export const MAX_DEVIATION_BPS = 100n;

/**
 * We step 0.9%, not the full 1%.
 *
 * The contract compares against the rate at execution time, and a run can land
 * a block or two after we read. Asking for the exact maximum would occasionally
 * revert DeviationTooLarge for the sake of 0.1%, and a reverted keeper run is
 * how a rate quietly ages into a halt.
 */
export const SAFE_STEP_BPS = 90n;

/** Push a heartbeat once the rate is this old, even with nothing to correct. */
export const HEARTBEAT_AFTER = 7_200; // 2h — a third of the staleness window

/** Warn the operator here, well before swaps actually stop. */
export const ALERT_AFTER = 14_400; // 4h

/** Plausible EUR->USD band. Anything outside is a broken feed, not a market move. */
export const RATE_MIN = 0.8;
export const RATE_MAX = 1.6;

/**
 * Never push an unvalidated number. A feed returning null, a string, NaN or a
 * decimal-shifted value would otherwise be signed straight into the oracle.
 */
export function validateFeedRate(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error(`feed returned a non-numeric rate: ${String(value)}`);
  if (n < RATE_MIN || n > RATE_MAX) {
    throw new Error(`feed rate ${n} is outside the sane band ${RATE_MIN}–${RATE_MAX}`);
  }
  return n;
}

export const toWad = (n: number): bigint => BigInt(Math.round(n * 1e18));
export const fromWad = (v: bigint): number => Number(v) / 1e18;

/**
 * Limit one step to SAFE_STEP_BPS of the stored rate.
 *
 * A large market gap is walked across successive runs rather than attempted in
 * one transaction that would revert. At 0.9% per 30 minutes, a 5% gap closes in
 * under three hours — comfortably inside the staleness window.
 */
export function clampStep(current: bigint, target: bigint, stepBps: bigint = SAFE_STEP_BPS): bigint {
  if (current <= 0n) return target;
  const maxDelta = (current * stepBps) / 10_000n;
  if (target > current + maxDelta) return current + maxDelta;
  if (target < current - maxDelta) return current - maxDelta;
  return target;
}

export type Decision =
  | { action: "push"; value: bigint; reason: string }
  | { action: "skip"; reason: string };

/**
 * Decide what this run should do.
 *
 * The heartbeat case matters most: when the market hasn't moved, there is
 * nothing to correct — but doing nothing lets `updatedAt` age until getRate()
 * reverts and the AMM halts. So past HEARTBEAT_AFTER we re-push the same value
 * purely to refresh the timestamp. diff == 0 always satisfies the deviation
 * check, so it cannot revert on that guard.
 */
export function decide(opts: {
  ageSeconds: number;
  currentWad: bigint;
  targetWad: bigint;
}): Decision {
  const { ageSeconds, currentWad, targetWad } = opts;

  if (ageSeconds < MIN_UPDATE_INTERVAL) {
    return { action: "skip", reason: `last update ${ageSeconds}s ago; setRate would revert TooSoon` };
  }

  const clamped = clampStep(currentWad, targetWad);

  if (clamped === currentWad) {
    if (ageSeconds > HEARTBEAT_AFTER) {
      return {
        action: "push",
        value: currentWad,
        reason: `heartbeat: no material change but rate is ${Math.round(ageSeconds / 60)}m old`,
      };
    }
    return { action: "skip", reason: "no material change and rate is fresh" };
  }

  const deltaBps = Number(((clamped - currentWad) * 10_000n) / currentWad);
  const wasClamped = clamped !== targetWad;
  return {
    action: "push",
    value: clamped,
    reason: wasClamped
      ? `stepping ${deltaBps > 0 ? "+" : ""}${(deltaBps / 100).toFixed(2)}% toward ${fromWad(targetWad).toFixed(6)} (clamped)`
      : `moving ${deltaBps > 0 ? "+" : ""}${(deltaBps / 100).toFixed(2)}% to ${fromWad(targetWad).toFixed(6)}`,
  };
}

/** The selector GuardedRateProvider.getRate() reverts with when stale. */
export const STALE_RATE_SELECTOR = "0xec30f4ab";

/**
 * A revert is only StaleRate if it carries that selector. Matching on message
 * text would misclassify unrelated failures as "just stale" and hide real ones.
 */
export function isStaleRateError(err: unknown): boolean {
  if (!err) return false;
  const s = typeof err === "string" ? err : JSON.stringify((err as Error)?.message ?? err);
  return s.toLowerCase().includes(STALE_RATE_SELECTOR);
}

export const formatAge = (seconds: number): string => {
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
};
