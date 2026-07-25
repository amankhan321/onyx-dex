import { NextResponse } from "next/server";

/**
 * OWNER / TESTING ONLY — status for the Mode 2 server bot (keeper/bot.mjs).
 *
 * Gated behind BOT_SECRET. This is NOT part of the public product: nothing in
 * the user-facing UI calls it, and the public bot (components/BotPanel.tsx)
 * runs client-side against the user's own wallet and needs no server at all.
 *
 * Deliberately READ-ONLY. Start/stop belongs to the process manager (pm2,
 * docker compose, systemd) that owns the worker — exposing lifecycle control
 * over HTTP would add an attack surface for zero benefit, since the worker
 * runs on a box the owner already has shell access to.
 *
 * If BOT_SECRET is unset the route is disabled entirely, so an unconfigured
 * deploy cannot leak anything.
 */

const RPC = process.env.RPC_URL ?? "https://rpc.testnet.arc.network";
const USDC = process.env.USDC ?? "0x3600000000000000000000000000000000000000";
const EURC = process.env.EURC ?? "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

async function ethCall(to: string, data: string) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  });
  const j = await r.json();
  return j?.result as string | undefined;
}

/** balanceOf(address) selector + padded address */
const balanceOfData = (addr: string) => `0x70a08231000000000000000000000000${addr.replace(/^0x/, "").toLowerCase()}`;

export async function GET(req: Request) {
  const secret = process.env.BOT_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "bot status endpoint not configured" }, { status: 404 });
  }
  const provided = req.headers.get("x-bot-secret") ?? new URL(req.url).searchParams.get("secret");
  if (provided !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const walletAddr = process.env.BOT_ADDRESS;
  if (!walletAddr) {
    return NextResponse.json({ error: "BOT_ADDRESS not set" }, { status: 400 });
  }

  try {
    const [u, e] = await Promise.all([
      ethCall(USDC, balanceOfData(walletAddr)),
      ethCall(EURC, balanceOfData(walletAddr)),
    ]);
    const dec = (hex?: string) => (hex ? Number(BigInt(hex)) / 1e6 : null);
    return NextResponse.json({
      wallet: walletAddr,
      usdc: dec(u),
      eurc: dec(e),
      strategy: process.env.BOT_STRATEGY ?? "mm",
      armed: process.env.BOT_ARMED === "true",
      maxCapital: Number(process.env.BOT_MAX_CAPITAL ?? "10"),
      note: "owner-only status; lifecycle is managed by the process manager, not HTTP",
    });
  } catch {
    return NextResponse.json({ error: "rpc read failed" }, { status: 502 });
  }
}
