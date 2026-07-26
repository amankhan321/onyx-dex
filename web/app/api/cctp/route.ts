import { NextResponse } from "next/server";

/**
 * Attestation lookup proxied server-side.
 *
 * Circle's Iris API is queried from our server rather than the browser: it
 * sidesteps CORS entirely and, as we learned the hard way with the Arc RPC,
 * server-side fetches on this stack are far more reliable than browser ones.
 * Read-only — it forwards a burn tx hash and returns Circle's response.
 */
const IRIS = "https://iris-api-sandbox.circle.com"; // sandbox = testnet

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const domain = searchParams.get("domain");
  const tx = searchParams.get("tx");

  if (!domain || !/^\d+$/.test(domain) || !tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    return NextResponse.json({ error: "bad params" }, { status: 400 });
  }

  try {
    const r = await fetch(`${IRIS}/v2/messages/${domain}?transactionHash=${tx}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!r.ok) return NextResponse.json({ status: "pending" });
    const j = await r.json();
    const m = j?.messages?.[0];
    if (!m || m.status !== "complete" || !m.attestation || m.attestation === "PENDING") {
      return NextResponse.json({ status: "pending" });
    }
    return NextResponse.json({ status: "complete", message: m.message, attestation: m.attestation });
  } catch {
    return NextResponse.json({ status: "pending" });
  }
}
