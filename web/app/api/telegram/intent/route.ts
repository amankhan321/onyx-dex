import { NextResponse } from "next/server";
import { verifyInitData } from "@/lib/bot/initData";
import { consumeIntent, consumeErrorMessage } from "@/lib/bot/intents";
import { intentStore } from "@/lib/bot/db";

/**
 * Consume a trade intent, once.
 *
 * The Mini App opens with an opaque id in start_param and exchanges it here for
 * the trade PARAMETERS that were parsed in chat. What comes back is never a
 * transaction and never anything signable — the device re-quotes and re-derives
 * every number before it signs, so a tampered or replayed id cannot move funds,
 * it can only fail.
 *
 * Identity comes from Telegram's HMAC-signed initData, not from anything the
 * caller asserts, so one user cannot spend another's intent even knowing its id.
 * The consume itself is a single atomic UPDATE (see db.ts intentStore), so a
 * double-tap or a deliberate replay loses the race and gets a clear refusal
 * rather than a second trade.
 *
 * Fails closed on every abuse: unknown id, wrong user, already consumed, or
 * expired. `wrong-user` and `not-found` return an identical message so ids
 * cannot be enumerated.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return NextResponse.json({ ok: false, error: "not configured" }, { status: 503 });
  }

  let body: { initData?: string; id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  const initData = typeof body.initData === "string" ? body.initData : "";
  const id = typeof body.id === "string" ? body.id : "";
  if (!initData || !id) {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  // Identity from Telegram's signature. Never from a field the caller supplies.
  const auth = verifyInitData(initData, botToken);
  if (!auth.ok || !auth.userId) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const result = await consumeIntent(intentStore, {
    id,
    telegramId: auth.userId,
    now: Date.now(),
  });

  if (!result.ok) {
    // 200 with ok:false — this is an expected outcome the UI renders as a
    // screen, not a transport failure. `expired` is flagged so the client can
    // offer a re-quote button instead of silently re-pricing.
    return NextResponse.json({
      ok: false,
      reason: result.reason,
      expired: result.reason === "expired",
      message: consumeErrorMessage(result.reason),
    });
  }

  // Parameters only. The device quotes and builds from these itself.
  return NextResponse.json({ ok: true, payload: result.payload });
}
