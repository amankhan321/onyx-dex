import crypto from "node:crypto";

/**
 * Verify Telegram's signed initData.
 *
 * Establishes WHICH telegram_id a Mini App session belongs to — identity only.
 * It must never gate access to key material, because there is none to gate:
 * keys live on the user's device and the server cannot sign.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 3600,
): { ok: boolean; userId?: number; username?: string } {
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

  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(hash, "hex");
  // Constant-time: a timing side channel here would leak the expected hash.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false };

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return { ok: false };

  try {
    const user = JSON.parse(params.get("user") ?? "{}");
    return { ok: true, userId: user?.id, username: user?.username };
  } catch {
    return { ok: true };
  }
}
