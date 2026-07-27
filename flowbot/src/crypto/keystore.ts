/**
 * Keystore types — TYPES ONLY, deliberately.
 *
 * The canonical implementation lives in `web/lib/keystore.ts`, because the
 * Mini App on the user's device is the only place it ever runs. This server
 * cannot decrypt anything: it never receives a password, by design. So it has
 * no business carrying a copy of the crypto — a second implementation could
 * silently drift from the one that actually guards funds.
 *
 * What the server handles is this opaque blob, and nothing else.
 */

export type EncryptedKeystore = {
  version: 1;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; dkLen: number };
  /** hex */
  salt: string;
  /** hex */
  iv: string;
  /** hex, includes the GCM auth tag */
  ciphertext: string;
};

/** Cheap shape check before storing an opt-in backup. Does not validate crypto. */
export function looksLikeKeystore(v: unknown): v is EncryptedKeystore {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  return (
    k.version === 1 &&
    k.kdf === "scrypt" &&
    typeof k.salt === "string" &&
    typeof k.iv === "string" &&
    typeof k.ciphertext === "string"
  );
}
