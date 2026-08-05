/**
 * Per-user rate limiting for the webhook.
 *
 * Every trading command costs at least one RPC read, so an unthrottled flood of
 * chat messages becomes a flood of chain reads. This caps each Telegram user
 * independently: one noisy user cannot degrade anyone else, and cannot exhaust
 * the RPC budget the keeper depends on.
 *
 * A token bucket rather than a fixed window, because a fixed window lets a user
 * send the whole allowance twice across a boundary. Refill is computed lazily
 * from elapsed time, so there is no timer to leak in a serverless function.
 *
 * In-memory and therefore per-instance: on Vercel this bounds a burst within one
 * warm lambda, which is exactly where a flood from a single chat lands. It is a
 * throttle, not a security control — nothing here protects funds, and nothing
 * here can sign.
 *
 * NOTE ON LOGGING: this module records a user id and a timestamp only. It never
 * sees or stores command text, so it cannot build a trading profile.
 */

export type Bucket = { tokens: number; last: number };

/** Sustained rate: a command every 3s, with a burst of 8. */
export const CAPACITY = 8;
export const REFILL_PER_SECOND = 1 / 3;

/** Evict idle buckets past this age so the map cannot grow without bound. */
const IDLE_EVICT_MS = 10 * 60 * 1000;
const MAX_BUCKETS = 10_000;

export function refill(bucket: Bucket, now: number, capacity = CAPACITY, rate = REFILL_PER_SECOND): Bucket {
  const elapsedSeconds = Math.max(0, (now - bucket.last) / 1000);
  return {
    tokens: Math.min(capacity, bucket.tokens + elapsedSeconds * rate),
    last: now,
  };
}

/**
 * Pure decision: returns the updated bucket and whether the request is allowed.
 * Separated from the store so the policy is testable without global state.
 */
export function consumeToken(
  bucket: Bucket | undefined,
  now: number,
  capacity = CAPACITY,
  rate = REFILL_PER_SECOND,
): { bucket: Bucket; allowed: boolean } {
  const current = bucket ? refill(bucket, now, capacity, rate) : { tokens: capacity, last: now };
  if (current.tokens < 1) return { bucket: current, allowed: false };
  return { bucket: { tokens: current.tokens - 1, last: now }, allowed: true };
}

const buckets = new Map<number, Bucket>();

/** True if this user may proceed. Call once per inbound message. */
export function allow(telegramId: number, now = Date.now()): boolean {
  if (buckets.size > MAX_BUCKETS) evictIdle(now);
  const { bucket, allowed } = consumeToken(buckets.get(telegramId), now);
  buckets.set(telegramId, bucket);
  return allowed;
}

/**
 * True the first time a user is throttled in a given stretch, so the bot can
 * say so once instead of replying to every message in the flood — which would
 * itself be a Telegram-side amplification.
 */
export function shouldWarn(telegramId: number, now = Date.now()): boolean {
  const b = buckets.get(telegramId);
  return !b || now - b.last > 30_000;
}

export function evictIdle(now: number) {
  for (const [id, b] of buckets) {
    if (now - b.last > IDLE_EVICT_MS) buckets.delete(id);
  }
}

/** Test hook. Never called in production paths. */
export function _reset() {
  buckets.clear();
}
