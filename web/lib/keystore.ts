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
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ARC_PATH = "m/44'/60'/0'/0/0"; // Arc is EVM — standard path

/** The only thing that may be persisted or backed up. Contains no cleartext secret. */
export type EncryptedKeystore = {
  version: 1;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; dkLen: number };
  salt: string;
  iv: string;
  ciphertext: string;
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
    version: 1,
    kdf: "scrypt",
    kdfParams: { ...KDF },
    salt: toHex(salt),
    iv: toHex(iv),
    ciphertext: toHex(ct),
  };
}

/**
 * Enforced in the crypto layer so no UI path can skip it. Stricter than a length
 * rule because the encrypted blob now syncs to Telegram's cloud — see
 * passwordStrength.ts for the threat model.
 */
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
  if (keystore.version !== 1 || keystore.kdf !== "scrypt") {
    throw new Error("Unsupported keystore version");
  }
  // Use the blob's own params so keystores written under older settings
  // still open. Reading the module constant here would strand them.
  const key = await deriveAesKey(password, fromHex(keystore.salt), keystore.kdfParams);
  let pk: Uint8Array;
  try {
    pk = new Uint8Array(
      await subtle().decrypt(
        { name: "AES-GCM", iv: fromHex(keystore.iv) as BufferSource },
        key,
        fromHex(keystore.ciphertext) as BufferSource,
      ),
    );
  } catch {
    // GCM auth failure. Deliberately vague — carries no key material.
    throw new Error("Wrong password or corrupted keystore");
  }
  const account = privateKeyToAccount(`0x${toHex(pk)}`);
  return { address: account.address, account, wipe: () => zero(pk) };
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
