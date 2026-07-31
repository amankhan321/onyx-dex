import { NextResponse } from "next/server";

/**
 * Same-origin JSON-RPC relay for Arc.
 *
 * WHY IT EXISTS: Arc's public RPC returns 403 to any request carrying a browser
 * Origin header, so the browser cannot talk to it directly. Reads went through
 * here; writes did not, which is why swaps failed with "HTTP request failed."
 *
 * WHY RELAYING A SIGNED TRANSACTION IS NOT CUSTODY: eth_sendRawTransaction
 * carries bytes that are already signed on the user's device. This server never
 * sees a key, cannot produce a signature, and cannot alter the payload — any
 * edit invalidates the signature and the network rejects it. Relaying is
 * postage, not authority.
 *
 * The methods that WOULD imply custody are refused and always will be:
 * eth_sendTransaction, eth_sign, eth_signTypedData*, personal_*, wallet_* all
 * presuppose that whoever handles them holds a key. We never do.
 */

const UPSTREAM = "https://rpc.testnet.arc.network";

/**
 * Explicit allowlist. The previous prefix blocklist was the wrong shape: it had
 * to anticipate every dangerous method, so anything new and dangerous would
 * have been permitted by default. An allowlist fails closed instead.
 */
const READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "net_version",
  "web3_clientVersion",
]);

/** The one write, kept separate so it can have its own budget. */
const SEND_METHOD = "eth_sendRawTransaction";

const isAllowed = (m: unknown): m is string =>
  typeof m === "string" && (READ_METHODS.has(m) || m === SEND_METHOD);

const isSend = (m: unknown) => m === SEND_METHOD;

/**
 * Separate buckets so a burst of polling reads can never 429 a broadcast. A
 * rejected read redraws a tile; a rejected broadcast loses a trade.
 */
const WINDOW_MS = 60_000;
const READ_LIMIT = 240;
const SEND_LIMIT = 30;
const buckets = new Map<string, { reads: number; sends: number; resetAt: number }>();

function takeToken(ip: string, send: boolean): boolean {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    buckets.set(ip, { reads: send ? 0 : 1, sends: send ? 1 : 0, resetAt: now + WINDOW_MS });
    return true;
  }
  if (send) {
    if (b.sends >= SEND_LIMIT) return false;
    b.sends++;
    return true;
  }
  if (b.reads >= READ_LIMIT) return false;
  b.reads++;
  return true;
}

async function forward(body: unknown) {
  const res = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  // Never log request or response bodies: a raw transaction and its receipt are
  // user financial activity, and logs are the easiest place to leak it.
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const rpcError = (id: unknown, code: number, message: string, status = 400) =>
  NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, { status });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0) return rpcError(null, -32600, "Empty request");

  const offending = calls.find((c) => !isAllowed((c as { method?: unknown })?.method));
  if (offending) {
    const m = String((offending as { method?: unknown })?.method ?? "unknown");
    return rpcError(
      (offending as { id?: unknown })?.id,
      -32601,
      `Method ${m} is not relayed. Reads and eth_sendRawTransaction only — anything that would require this server to hold a key is refused by design.`,
      403,
    );
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "anon";
  const anySend = calls.some((c) => isSend((c as { method?: unknown })?.method));

  if (!takeToken(ip, anySend)) {
    return rpcError(
      (calls[0] as { id?: unknown })?.id,
      -32005,
      anySend ? "Too many broadcasts, slow down" : "Too many requests",
      429,
    );
  }

  try {
    return await forward(body);
  } catch {
    return rpcError((calls[0] as { id?: unknown })?.id, -32603, "Upstream unavailable", 502);
  }
}

/** Liveness probe — returns the chain id so a browser can verify the relay works. */
export async function GET() {
  try {
    return await forward({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
  } catch {
    return rpcError(1, -32603, "Upstream unavailable", 502);
  }
}
