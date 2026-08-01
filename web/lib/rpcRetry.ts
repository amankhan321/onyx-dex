/**
 * Shared RPC retry policy — used by BOTH the browser transport and the Node
 * keeper script.
 *
 * Extracted rather than copied. The keeper died on run #17, #18 and #21 because
 * it had no retry at all while the browser transport did; two implementations
 * would have let that divergence happen again.
 *
 * Arc's public RPC rate-limits aggressively and reports it two ways:
 *   HTTP 429
 *   JSON-RPC error -32011 "request limit reached"   ← what killed the keeper
 * Both are transient. A revert or a nonce error is a real answer and must never
 * be retried: repeating a doomed transaction wastes gas, and re-racing a used
 * nonce makes things worse.
 */

export const MAX_ATTEMPTS = 6;
export const BASE_DELAY_MS = 500;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, so many clients don't retry in lockstep. */
export function backoffDelay(attempt: number, base = BASE_DELAY_MS): number {
  const exponential = base * 2 ** (attempt - 1);
  return exponential + Math.random() * exponential * 0.5;
}

/** Rate limiting, in either of the forms Arc reports it. */
export function isRateLimited(err: unknown): boolean {
  const s = String((err as Error)?.message ?? err);
  return (
    s.includes("429") ||
    s.includes("-32011") ||
    /rate.?limit|too many requests|request limit reached/i.test(s)
  );
}

/** A real answer from the chain — retrying changes nothing or makes it worse. */
export function isTerminalChainError(err: unknown): boolean {
  const s = String((err as Error)?.message ?? err).toLowerCase();
  return /revert|nonce|already known|replacement|underpriced|insufficient funds|execution reverted/.test(s);
}

/** Transport-level failures worth another attempt. */
export function isTransient(err: unknown): boolean {
  if (isTerminalChainError(err)) return false;
  if (isRateLimited(err)) return true;
  const s = String((err as Error)?.message ?? err).toLowerCase();
  return /\b5\d\d\b|upstream|network|timeout|fetch failed|econn|socket|http request failed/.test(s);
}

/**
 * Run `fn`, retrying transient failures. Spans roughly 60s across 6 attempts at
 * the default base — long enough to outlast a rate-limit window, short enough
 * that a scheduled run doesn't hang.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; base?: number; onRetry?: (attempt: number, err: unknown, waitMs: number) => void } = {},
): Promise<T> {
  const attempts = opts.attempts ?? MAX_ATTEMPTS;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === attempts || !isTransient(e)) throw e;
      const wait = backoffDelay(attempt, opts.base);
      opts.onRetry?.(attempt, e, wait);
      await sleep(wait);
    }
  }
  throw lastErr;
}
