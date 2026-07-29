import { NextResponse } from "next/server";
import { setWebhook } from "@/lib/bot/telegram";
import { ensureSchema } from "@/lib/bot/db";

/**
 * One-time webhook registration.
 *
 * Runs server-side on purpose. Telegram's setWebhook requires the bot token in
 * the request path, so calling it from a browser would leave the token in the
 * URL bar, history, and any referrer — this way it never leaves Vercel's
 * environment. Triggered from a GitHub Action holding only the admin secret.
 *
 * POST-only and header-authenticated, so it can't be fired by following a link.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const admin = process.env.TELEGRAM_ADMIN_SECRET;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!admin || !webhookSecret) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  if (req.headers.get("x-admin-secret") !== admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const base =
    process.env.PUBLIC_BASE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : null);
  if (!base) {
    return NextResponse.json({ error: "PUBLIC_BASE_URL is not set" }, { status: 400 });
  }

  try {
    await ensureSchema();
    await setWebhook(`${base}/api/telegram/webhook`, webhookSecret);
    // Echo the URL but never the token or the secrets.
    return NextResponse.json({ ok: true, webhook: `${base}/api/telegram/webhook` });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "setWebhook failed" },
      { status: 502 },
    );
  }
}
