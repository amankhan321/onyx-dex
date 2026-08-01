/**
 * FX reference sources for EUR/USD.
 *
 * AUTHORITATIVE SOURCE: the European Central Bank. Every entry below ultimately
 * republishes the ECB's daily reference rate — that is the number Onyx's oracle
 * is meant to track, and it is what the StableSwap's rate-adjusted invariant
 * assumes. The providers differ only in how they serve it.
 *
 * WHY THREE, AND WHY NOT TWO SPELLINGS OF ONE:
 * frankfurter.dev and frankfurter.app are the same service, so listing both is
 * not redundancy — when Frankfurter is down, both are down. exchangerate.host
 * is a genuinely separate operator, so a single provider outage cannot take the
 * feed to zero. The keeper going quiet is how the oracle went stale and halted
 * trading, so the third source is the difference between a slow day and a halt.
 *
 * PATHS DIFFER PER HOST — this is the bug this file fixes:
 *   frankfurter.dev REQUIRES the /v1 prefix; without it every request 404s
 *   frankfurter.app does NOT take /v1
 * Promoting .dev to primary while keeping .app's path meant the primary 404'd
 * on every call and the fallback was already dead, so the tape emptied.
 */

export type FxSource = {
  name: string;
  /** Full URL for a EUR->USD quote. */
  url: string;
  /** Pull the USD-per-EUR number out of that provider's response shape. */
  extract: (json: unknown) => number | undefined;
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** EUR -> USD, in priority order. */
export const EUR_USD_SOURCES: FxSource[] = [
  {
    name: "frankfurter.dev",
    // /v1 is mandatory on this host.
    url: "https://api.frankfurter.dev/v1/latest?base=EUR&symbols=USD",
    extract: (j) => num((j as { rates?: Record<string, unknown> })?.rates?.USD),
  },
  {
    name: "frankfurter.app",
    // Legacy host, no /v1. Often unreachable; kept in case .dev regresses.
    url: "https://api.frankfurter.app/latest?base=EUR&symbols=USD",
    extract: (j) => num((j as { rates?: Record<string, unknown> })?.rates?.USD),
  },
  {
    name: "exchangerate.host",
    // Independent operator, also republishing ECB rates. The actual redundancy.
    url: "https://api.exchangerate.host/latest?base=EUR&symbols=USD",
    extract: (j) => num((j as { rates?: Record<string, unknown> })?.rates?.USD),
  },
];

/** USD -> EUR/GBP/JPY for the reference tape. */
export const TAPE_SOURCES: FxSource[] = [
  {
    name: "frankfurter.dev",
    url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR,GBP,JPY",
    extract: (j) => num((j as { rates?: Record<string, unknown> })?.rates?.EUR),
  },
  {
    name: "frankfurter.app",
    url: "https://api.frankfurter.app/latest?base=USD&symbols=EUR,GBP,JPY",
    extract: (j) => num((j as { rates?: Record<string, unknown> })?.rates?.EUR),
  },
  {
    name: "exchangerate.host",
    url: "https://api.exchangerate.host/latest?base=USD&symbols=EUR,GBP,JPY",
    extract: (j) => num((j as { rates?: Record<string, unknown> })?.rates?.EUR),
  },
];

/**
 * Try each source in order. A 404, a 503 or an unparseable body all fall
 * through to the next — only exhausting every source is a failure.
 */
export async function fetchFirst<T>(
  sources: FxSource[],
  parse: (json: unknown, source: FxSource) => T | null,
): Promise<{ value: T; source: string }> {
  const errors: string[] = [];
  for (const s of sources) {
    try {
      const res = await fetch(s.url, { headers: { accept: "application/json" } });
      if (!res.ok) {
        errors.push(`${s.name}: HTTP ${res.status}`);
        continue;
      }
      const json = await res.json();
      const value = parse(json, s);
      if (value === null) {
        errors.push(`${s.name}: no usable rates`);
        continue;
      }
      return { value, source: s.name };
    } catch (e) {
      errors.push(`${s.name}: ${e instanceof Error ? e.message.slice(0, 60) : "failed"}`);
    }
  }
  throw new Error(`all FX sources failed — ${errors.join("; ")}`);
}
