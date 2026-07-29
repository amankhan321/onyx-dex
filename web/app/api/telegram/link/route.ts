import { NextResponse } from "next/server";
import { isAddress, getAddress } from "viem";
import { verifyInitData } from "@/lib/bot/initData";
import { ensureSchema, setAddress, upsertUser } from "@/lib/bot/db";

/**
 * Link a wallet address to a Telegram account, so fills and alerts can be
 * delivered to the right chat.
 *
 * The Mini App posts { address, initData }. The initData HMAC is verified with
 * the bot token BEFORE anything is stored — otherwise anyone could claim any
 * telegram_id and redirect another user's notifications to themselves.
 *
 * Stores the public address only. Never key material: the server has none and
 * cannot obtain any.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return NextResponse.json({ error: "not configured" }, { status: 503 });

  let body: { address?: string; initData?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (!body.initData || typeof body.initData !== "string") {
    return NextResponse.json({ error: "missing initData" }, { status: 400 });
  }
  if (!body.address || !isAddress(body.address)) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }

  const v = verifyInitData(body.initData, botToken);
  if (!v.ok || !v.userId) {
    return NextResponse.json({ error: "invalid session" }, { status: 401 });
  }

  try {
    await ensureSchema();
    await upsertUser(v.userId, v.username);
    await setAddress(v.userId, getAddress(body.address));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "storage unavailable" }, { status: 503 });
  }
}
