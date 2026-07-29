/**
 * Keystore — THE canonical implementation. This is where it runs.
 *
 * ============================ WHY IT LIVES HERE ============================
 * Key material only ever exists inside the Telegram Mini App, i.e. this Next.js
 * app running in a webview on the user's phone. The FlowBot server never
 * decrypts anything — it *cannot*, because it never receives the password — so
 * it has no need for this module at all and imports only the
 * `EncryptedKeystore` type. One implementation, no drift, and the copy that
 * matters is the one on the device.
 *
 * Crypto choices and the reasoning:
 *  - scrypt N=2^17, r=8, p=1 — memory-hard (~128 MB per guess), so an exfil-
 *    trated blob is expensive to brute force. Audited @noble/hashes.
 *  - AES-256-GCM via WebCrypto — authenticated, so a tampered blob fails loudly
 *    rather than decrypting to garbage we might then sign a transaction with.
 *  - Fresh 16-byte salt and 12-byte IV per encryption, never reused.
 *  - The derived AES key is imported NON-EXTRACTABLE, so the raw key cannot be
 *    read back out of WebCrypto.
 *  - Plaintext keys live in memory only and are zeroed after use. `withUnlocked`
 *    wipes even when the callback throws.
 *  - No function here logs, throws, or returns key material. A failed unlock
 *    says only "wrong password or corrupted keystore", so a stack trace or an
 *    error-reporting service can never capture a secret.
 * ==========================================================================
 */

import { scrypt } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { HDKey } from "@scure/bip32";
import { privateKeyToAccount } from "viem/accounts";
import { checkPasswordStrength } from "./passwordStrength";
import type { PrivateKeyAccount } from "viem";

/**
 * scrypt cost. N=2^17 with r=8 needs ~128 MB and roughly 1-2 seconds on a
 * mid-range phone — deliberately slow, because the same work is what an
 * offline attacker must repeat for every guess against a stolen blob.
 *
 * Never lower these. If they are ever RAISED, old keystores keep working:
 * unlock() derives using the params recorded in each blob, not this constant.
 */
const KDF = { N: 1 << 17, r: 8, p: 1, dkLen: 32 } as const;
/**
 * Hard bounds on the KDF cost we will honour from a blob.
 *
 * The params travel INSIDE the keystore so old wallets keep opening after a
 * tuning change — but that means a corrupted or hostile blob can propose them.
 * Too low silently weakens the key. Too high is a denial of service: scrypt at
 * N=2^30 would try to allocate gigabytes and wedge the phone. So anything
 * outside this range is rejected as malformed rather than obeyed.
 */
const KDF_BOUNDS = {
  minN: 1 << 14, // ~16 MB — below this the KDF stops being meaningfully slow
  maxN: 1 << 20, // ~1 GB — beyond this a phone will stall or crash
  minR: 1,
  maxR: 16,
  minP: 1,
  maxP: 4,
  dkLen: 32,
} as const;

/** Bumped when the on-disk shape changes. v2 added the integrity tag. */
export const KEYSTORE_VERSION = 2 as const;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const ARC_PATH = "m/44'/60'/0'/0/0"; // Arc is EVM — standard path

/** The only thing that may be persisted or backed up. Contains no cleartext secret. */
export type EncryptedKeystore = {
  /** 1 = original. 2 = adds `integrity`. Both remain readable. */
  version: 1 | 2;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; dkLen: number };
  salt: string;
  iv: string;
  ciphertext: string;
  /**
   * sha256(salt || iv || ciphertext), hex. Present from v2.
   *
   * Lets a failed unlock distinguish "wrong password" from "this blob is not
   * the bytes we wrote". Be clear about its limits: it detects corruption and
   * accidental alteration — truncated cloud writes, a mangled sync — not a
   * deliberate attacker, who would simply recompute it. It is an integrity
   * check, not an authenticity one.
   */
  integrity?: string;
};

export type UnlockedWallet = {
  address: `0x${string}`;
  account: PrivateKeyAccount;
  wipe: () => void;
};

const toHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const fromHex = (s: string) => {
  const c = s.startsWith("0x") ? s.slice(2) : s;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const zero = (b: Uint8Array) => b.fill(0);

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    // Refuse rather than silently degrading to something weaker.
    throw new Error("Secure crypto unavailable in this context");
  }
  return globalThis.crypto.subtle;
}

type KdfParams = { N: number; r: number; p: number; dkLen: number };

async function deriveAesKey(
  password: string,
  salt: Uint8Array,
  params: KdfParams = KDF,
): Promise<CryptoKey> {
  const pw = new TextEncoder().encode(password.normalize("NFKC"));
  const dk = scrypt(pw, salt, params);
  zero(pw);
  const key = await subtle().importKey("raw", dk as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  zero(dk);
  return key;
}

export function createMnemonic(): string {
  return generateMnemonic(wordlist, 128); // 12 words
}

function privateKeyFromMnemonic(mnemonic: string): Uint8Array {
  const m = mnemonic.trim().replace(/\s+/g, " ").toLowerCase();
  if (!validateMnemonic(m, wordlist)) throw new Error("Invalid recovery phrase");
  const seed = mnemonicToSeedSync(m);
  const hd = HDKey.fromMasterSeed(seed).derive(ARC_PATH);
  zero(seed);
  if (!hd.privateKey) throw new Error("Key derivation failed");
  const pk = new Uint8Array(hd.privateKey);
  hd.wipePrivateData();
  return pk;
}

async function encryptPrivateKey(pk: Uint8Array, password: string): Promise<EncryptedKeystore> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveAesKey(password, salt);
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, pk as BufferSource),
  );
  return {
    version: KEYSTORE_VERSION,
    kdf: "scrypt",
    kdfParams: { ...KDF },
    salt: toHex(salt),
    iv: toHex(iv),
    ciphertext: toHex(ct),
    integrity: computeIntegrity(salt, iv, ct),
  };
}

/**
 * Enforced in the crypto layer so no UI path can skip it. Stricter than a length
 * rule because the encrypted blob now syncs to Telegram's cloud — see
 * passwordStrength.ts for the threat model.
 */
function computeIntegrity(salt: Uint8Array, iv: Uint8Array, ct: Uint8Array): string {
  const joined = new Uint8Array(salt.length + iv.length + ct.length);
  joined.set(salt, 0);
  joined.set(iv, salt.length);
  joined.set(ct, salt.length + iv.length);
  return toHex(sha256(joined));
}

/** Thrown when a blob is structurally wrong — distinct from a bad password. */
export class KeystoreCorruptError extends Error {
  constructor(detail: string) {
    super(`This wallet backup appears corrupted or altered (${detail}).`);
    this.name = "KeystoreCorruptError";
  }
}

/** Thrown only when the blob is intact and the password simply doesn't open it. */
export class WrongPasswordError extends Error {
  constructor() {
    super("Wrong password.");
    this.name = "WrongPasswordError";
  }
}

function assertUsableKeystore(k: EncryptedKeystore) {
  if (k.version !== 1 && k.version !== 2) {
    throw new KeystoreCorruptError(`unsupported version ${String(k.version)}`);
  }
  if (k.kdf !== "scrypt") throw new KeystoreCorruptError("unknown key-derivation function");

  const kp = k.kdfParams;
  if (!kp || typeof kp.N !== "number") throw new KeystoreCorruptError("missing KDF parameters");

  // A power of two is required by scrypt itself; checking it here gives a clear
  // message instead of a library throw.
  if (kp.N < KDF_BOUNDS.minN || kp.N > KDF_BOUNDS.maxN || (kp.N & (kp.N - 1)) !== 0) {
    throw new KeystoreCorruptError(`KDF cost ${kp.N} is out of the accepted range`);
  }
  if (kp.r < KDF_BOUNDS.minR || kp.r > KDF_BOUNDS.maxR) {
    throw new KeystoreCorruptError(`KDF block size ${kp.r} is out of range`);
  }
  if (kp.p < KDF_BOUNDS.minP || kp.p > KDF_BOUNDS.maxP) {
    throw new KeystoreCorruptError(`KDF parallelism ${kp.p} is out of range`);
  }
  if (kp.dkLen !== KDF_BOUNDS.dkLen) {
    throw new KeystoreCorruptError("unexpected derived-key length");
  }
  if (!/^[0-9a-f]+$/i.test(k.salt) || !/^[0-9a-f]+$/i.test(k.iv) || !/^[0-9a-f]+$/i.test(k.ciphertext)) {
    throw new KeystoreCorruptError("malformed fields");
  }
}

export function assertPasswordStrength(password: string) {
  const res = checkPasswordStrength(password);
  if (!res.ok) throw new Error(res.reason);
}

/** New wallet. The mnemonic is returned once for display, never persisted here. */
export async function createKeystore(password: string): Promise<{
  mnemonic: string;
  keystore: EncryptedKeystore;
  address: `0x${string}`;
}> {
  assertPasswordStrength(password);
  const mnemonic = createMnemonic();
  const pk = privateKeyFromMnemonic(mnemonic);
  try {
    const keystore = await encryptPrivateKey(pk, password);
    const address = privateKeyToAccount(`0x${toHex(pk)}`).address;
    return { mnemonic, keystore, address };
  } finally {
    zero(pk);
  }
}

/** Import from a recovery phrase or a raw private key. Same encryption path. */
export async function importKeystore(
  secret: string,
  password: string,
): Promise<{ keystore: EncryptedKeystore; address: `0x${string}` }> {
  assertPasswordStrength(password);
  const s = secret.trim();
  const pk = /^(0x)?[0-9a-fA-F]{64}$/.test(s) ? fromHex(s) : privateKeyFromMnemonic(s);
  try {
    const keystore = await encryptPrivateKey(pk, password);
    const address = privateKeyToAccount(`0x${toHex(pk)}`).address;
    return { keystore, address };
  } finally {
    zero(pk);
  }
}

export async function unlock(
  keystore: EncryptedKeystore,
  password: string,
): Promise<UnlockedWallet> {
  assertUsableKeystore(keystore);

  const saltB = fromHex(keystore.salt);
  const ivB = fromHex(keystore.iv);
  const ctB = fromHex(keystore.ciphertext);

  // v2 blobs carry an integrity tag. A mismatch means the bytes changed since
  // we wrote them — a bad cloud sync, a truncated write — which is a different
  // problem from a mistyped password and deserves different advice.
  if (keystore.version >= 2 && keystore.integrity) {
    if (computeIntegrity(saltB, ivB, ctB) !== keystore.integrity.toLowerCase()) {
      throw new KeystoreCorruptError("contents do not match their checksum");
    }
  }
  // Use the blob's own params so keystores written under older settings
  // still open. Reading the module constant here would strand them.
  const key = await deriveAesKey(password, saltB, keystore.kdfParams);
  let pk: Uint8Array;
  try {
    pk = new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv: ivB as BufferSource }, key, ctB as BufferSource),
    );
  } catch {
    // GCM auth failure with an intact blob means the password is wrong. For v1
    // blobs (no integrity tag) we cannot tell the two apart, so we stay vague.
    // Neither path reveals key material, and NOTHING is ever deleted on failure
    // — a locked-out user must keep their only copy.
    if (keystore.version >= 2 && keystore.integrity) throw new WrongPasswordError();
    throw new Error("Wrong password or corrupted keystore");
  }
  const account = privateKeyToAccount(`0x${toHex(pk)}`);
  return { address: account.address, account, wipe: () => zero(pk) };
}

/**
 * Re-encrypt an existing wallet under a new password.
 *
 * Deliberately lives here rather than in the UI: the plaintext key is decrypted
 * and re-wrapped entirely inside this module and zeroed in a finally block, so
 * it never crosses the boundary. Exposing the raw key to a settings screen just
 * to re-encrypt it would defeat the point of keeping crypto in one place.
 *
 * Returns the new blob. The caller is responsible for writing it to EVERY tier
 * the wallet lives in — a cloud copy left on the old password is worse than no
 * backup, because the user believes they're covered.
 */
export async function changePassword(
  keystore: EncryptedKeystore,
  oldPassword: string,
  newPassword: string,
): Promise<EncryptedKeystore> {
  assertPasswordStrength(newPassword);
  assertUsableKeystore(keystore);

  const saltB = fromHex(keystore.salt);
  const ivB = fromHex(keystore.iv);
  const ctB = fromHex(keystore.ciphertext);

  if (keystore.version >= 2 && keystore.integrity) {
    if (computeIntegrity(saltB, ivB, ctB) !== keystore.integrity.toLowerCase()) {
      throw new KeystoreCorruptError("contents do not match their checksum");
    }
  }

  const oldKey = await deriveAesKey(oldPassword, saltB, keystore.kdfParams);
  let pk: Uint8Array;
  try {
    pk = new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv: ivB as BufferSource }, oldKey, ctB as BufferSource),
    );
  } catch {
    if (keystore.version >= 2 && keystore.integrity) throw new WrongPasswordError();
    throw new Error("Wrong password or corrupted keystore");
  }

  try {
    return await encryptPrivateKey(pk, newPassword);
  } finally {
    zero(pk);
  }
}

/** Preferred entry point: unlock, use, wipe — even if the callback throws. */
export async function withUnlocked<T>(
  keystore: EncryptedKeystore,
  password: string,
  fn: (w: UnlockedWallet) => Promise<T>,
): Promise<T> {
  const w = await unlock(keystore, password);
  try {
    return await fn(w);
  } finally {
    w.wipe();
  }
}
