import { custom, type EIP1193RequestFn } from "viem";
import { backoffDelay, isRateLimited, isTransient, sleep, MAX_ATTEMPTS } from "./rpcRetry";

/**
 * RPC transport with request de-duplication and 429 backoff.
 *
 * Measured on the landing page: 19 POSTs to /api/rpc for one load, 6 of them
 * rejected with 429 — which is what surfaced as "Couldn't load this right now"
 * and 0.00 tiles. Two causes, both fixed here rather than by polling less:
 *
 *   1. Duplicate work. Several components legitimately want the same value in
 *      the same tick (a balance read by both the swap panel and the portfolio,
 *      say). Identical in-flight requests are now collapsed into one.
 *   2. No retry. A 429 was fatal for that read. It now backs off and retries,
 *      and callers keep their last good value on screen meanwhile via
 *      placeholderData / useMiniPoll.
 *
 * The jitter here is on request TIMING, which is the legitimate use — it stops
 * every client retrying on the same beat. It is never applied to a price.
 */

type RpcArgs = { method: string; params?: unknown };

/** Identical concurrent requests share one promise. */
const inflight = new Map<string, Promise<unknown>>();

const keyOf = (args: RpcArgs) => `${args.method}:${JSON.stringify(args.params ?? [])}`;

/** Only de-duplicate reads. Anything state-changing must always be its own call. */
const isDedupable = (method: string) =>
  method === "eth_call" ||
  method === "eth_getBalance" ||
  method === "eth_chainId" ||
  method === "eth_blockNumber" ||
  method === "eth_getBlockByNumber";

async function post(url: string, args: RpcArgs): Promise<unknown> {
  let lastErr: unknown;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: args.method, params: args.params ?? [] }),
        cache: "no-store",
      });

      if (res.status === 429) {
        lastErr = new Error("429 rate limited");
        continue;
      }
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (json.error) throw new Error(json.error.message ?? "RPC error");
      return json.result;
    } catch (e) {
      lastErr = e;
      // Sends tolerate transport failures (a re-send of identical signed bytes
      // is idempotent — same hash); reads only retry on rate limiting.
      const retryable =
        args.method === "eth_sendRawTransaction" ? isTransient(e) : isRateLimited(e);
      if (!retryable) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("RPC request failed");
}

export function dedupedTransport(url: string) {
  const request: EIP1193RequestFn = async (args) => {
    const a = args as RpcArgs;

    if (!isDedupable(a.method)) return post(url, a) as never;

    const key = keyOf(a);
    const existing = inflight.get(key);
    if (existing) return existing as never;

    const p = post(url, a).finally(() => {
      // Cleared on settle, so this collapses concurrent duplicates without ever
      // serving a cached (and therefore possibly stale) value.
      inflight.delete(key);
    });
    inflight.set(key, p);
    return p as never;
  };

  return custom({ request });
}

/** Test hook: how many identical requests are currently collapsed into one. */
export const inflightCount = () => inflight.size;


/**
 * The only transport any browser code should use.
 *
 * Centralised so no component can accidentally reintroduce a direct connection
 * to Arc — which 403s from a browser and silently breaks writes.
 */
export function browserTransport() {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return dedupedTransport(`${origin}/api/rpc`);
}
