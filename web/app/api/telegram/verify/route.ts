import { NextResponse } from "next/server";
import crypto from "node:crypto";

/**
 * Telegram initData verification — IDENTITY ONLY.
 *
 * Confirms which telegram_id a Mini App session belongs to, by recomputing
 * Telegram's HMAC with the bot token. That is all it does.
 *
 * It MUST NOT gate, unlock, or authorise access to key material. Keys are
 * device-local and password-locked, so even a forged or replayed session cannot
 * move funds — the server has nothing to hand over. Identity is for menus,
 * history and notifications; custody stays on the device.
 */

const MAX_AGE_SECONDS = 3600; // reject stale initData (replay window)

function verify(initData: string, botToken: string): { ok: boolean; userId?: number } {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false };
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  // Constant-time compare — a timing side channel here would leak the hash.
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) return { ok: false };

  try {
    const user = JSON.parse(params.get("user") ?? "{}");
    return { ok: true, userId: user?.id };
  } catch {
    return { ok: true };
  }
}

export async function POST(req: Request) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }
  let initData = "";
  try {
    ({ initData } = await req.json());
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof initData !== "string" || initData.length === 0) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const result = verify(initData, botToken);
  if (!result.ok) return NextResponse.json({ error: "invalid session" }, { status: 401 });

  return NextResponse.json({ ok: true, telegramId: result.userId });
}
