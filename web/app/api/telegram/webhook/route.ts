import { NextResponse } from "next/server";
import { handleCallback, handleMessage } from "@/lib/bot/handlers";
import { ensureSchema } from "@/lib/bot/db";

/**
 * Telegram webhook.
 *
 * The route path is not a secret — anyone can guess /api/telegram/webhook. What
 * authenticates a request is the secret_token header Telegram sends, which was
 * registered via setWebhook and is known only to Telegram and this deployment.
 * Without it, anyone could POST a forged update claiming to be any user.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let schemaReady = false;

export async function POST(req: Request) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  if (req.headers.get("x-telegram-bot-api-secret-token") !== expected) {
    // Deliberately terse: a forged caller learns nothing about why it failed.
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let update: Record<string, unknown>;
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true }); // malformed: ack so Telegram stops retrying
  }

  try {
    if (!schemaReady) {
      await ensureSchema();
      schemaReady = true;
    }
    if (update.message) await handleMessage(update.message as never);
    else if (update.callback_query) await handleCallback(update.callback_query as never);
  } catch (e) {
    // Always 200: a non-2xx makes Telegram retry the same update repeatedly.
    // Log only the message — an update body could contain user text.
    console.error("[webhook]", e instanceof Error ? e.message : "handler failed");
  }

  return NextResponse.json({ ok: true });
}
