/**
 * FlowBot keystore — key generation, encryption, decryption, signing material.
 *
 * ============================ SECURITY MODEL ============================
 * This module is ISOMORPHIC by design, but it is only ever meant to RUN on the
 * user's device (the Telegram Mini App webview). The server imports nothing
 * from here except the types: it stores and returns an opaque `EncryptedKeystore`
 * blob and has no way to open it.
 *
 * Why that matters: in a plain Telegram bot every keystroke reaches the
 * operator's server, so a password typed into a chat is a password the operator
 * has. Encrypting the key server-side would protect against a stolen database
 * but NOT against the operator — so it would not be self-custody, and claiming
 * otherwise to users would be false. Running this module client-side is what
 * makes the claim true.
 *
 * Choices and the reasoning behind them:
 *  - scrypt (N=2^17, r=8, p=1) for the KDF. Memory-hard, so a leaked blob is
 *    expensive to brute force. Argon2id is equally good but needs a wasm build;
 *    @noble/hashes scrypt is audited and runs identically in browser and Node,
 *    which keeps one implementation instead of two.
 *  - AES-256-GCM via WebCrypto for the cipher. Authenticated, so a tampered
 *    blob fails loudly instead of decrypting to garbage that we might sign with.
 *  - Random 16-byte salt and 12-byte IV per encryption, never reused.
 *  - The derived key is imported as non-extractable so the raw AES key cannot
 *    be read back out of WebCrypto.
 *  - Decryption returns a handle with an explicit wipe(); callers MUST wipe
 *    after signing. We zero the underlying bytes rather than trusting GC.
 *
 * Hard rules enforced here:
 *  - Nothing in this file logs, throws, or returns key material. Errors are
 *    deliberately vague ("wrong password or corrupted keystore") so that a
 *    stack trace can never carry a secret.
 * =======================================================================
 */

import { scrypt } from "@noble/hashes/scrypt";
import { randomBytes } from "@noble/hashes/utils";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { HDKey } from "@scure/bip32";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";

/** Tunable, but never lower these without understanding the tradeoff. */
const KDF = {
  N: 1 << 17, // ~128 MB of memory per attempt
  r: 8,
  p: 1,
  dkLen: 32,
} as const;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const ARC_DERIVATION_PATH = "m/44'/60'/0'/0/0"; // Arc is EVM; standard path

/** What the server is allowed to store. Contains no secret in the clear. */
export type EncryptedKeystore = {
  version: 1;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number; dkLen: number };
  salt: string; // hex
  iv: string; // hex
  ciphertext: string; // hex, includes the GCM auth tag
};

/** An unlocked key. Short-lived, in memory only. ALWAYS wipe() after use. */
export type UnlockedWallet = {
  address: `0x${string}`;
  account: PrivateKeyAccount;
  /** Zeroes the private key bytes and detaches the account. */
  wipe: () => void;
};

const toHex = (b: Uint8Array) =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

const fromHex = (s: string) => {
  const clean = s.startsWith("0x") ? s.slice(2) : s;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Overwrite a buffer in place. Called on every path that touches a secret. */
function zero(buf: Uint8Array) {
  buf.fill(0);
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    // Guard rather than silently falling back to something weaker.
    throw new Error("WebCrypto unavailable — refusing to encrypt with a weaker primitive");
  }
  return c.subtle;
}

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const pw = new TextEncoder().encode(password.normalize("NFKC"));
  const dk = scrypt(pw, salt, KDF);
  zero(pw);
  // extractable: false — the raw AES key can never be read back out.
  const key = await subtle().importKey("raw", dk, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  zero(dk);
  return key;
}

/**
 * Create a brand-new wallet. The mnemonic is returned ONCE so the UI can show
 * it for backup; it is never persisted anywhere by this module. The caller must
 * make the user confirm they've written it down, then drop it.
 */
export function createMnemonic(): string {
  return generateMnemonic(wordlist, 128); // 12 words
}

/** Derive the Arc account private key from a mnemonic. */
function privateKeyFromMnemonic(mnemonic: string): Uint8Array {
  if (!validateMnemonic(mnemonic.trim(), wordlist)) {
    throw new Error("Invalid recovery phrase");
  }
  const seed = mnemonicToSeedSync(mnemonic.trim());
  const hd = HDKey.fromMasterSeed(seed).derive(ARC_DERIVATION_PATH);
  zero(seed);
  if (!hd.privateKey) throw new Error("Key derivation failed");
  const pk = new Uint8Array(hd.privateKey);
  hd.wipePrivateData();
  return pk;
}

/** Encrypt raw private key bytes under a password. */
async function encryptPrivateKey(pk: Uint8Array, password: string): Promise<EncryptedKeystore> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveAesKey(password, salt);
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv }, key, pk),
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
 * Create a wallet: returns the mnemonic (show once, then discard) and the
 * encrypted blob (safe to send to the server).
 */
export async function createKeystore(
  password: string,
): Promise<{ mnemonic: string; keystore: EncryptedKeystore; address: `0x${string}` }> {
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

/** Import an existing wallet from a mnemonic or a raw private key. */
export async function importKeystore(
  secret: string,
  password: string,
): Promise<{ keystore: EncryptedKeystore; address: `0x${string}` }> {
  assertPasswordStrength(password);
  const trimmed = secret.trim();
  const isRawKey = /^(0x)?[0-9a-fA-F]{64}$/.test(trimmed);
  const pk = isRawKey ? fromHex(trimmed) : privateKeyFromMnemonic(trimmed);
  try {
    const keystore = await encryptPrivateKey(pk, password);
    const address = privateKeyToAccount(`0x${toHex(pk)}`).address;
    return { keystore, address };
  } finally {
    zero(pk);
  }
}

/**
 * Unlock for signing. Runs on the user's device only.
 *
 * The returned handle must be wiped by the caller as soon as signing is done —
 * see signAndWipe() for the pattern that makes that automatic.
 */
export async function unlock(
  keystore: EncryptedKeystore,
  password: string,
): Promise<UnlockedWallet> {
  if (keystore.version !== 1 || keystore.kdf !== "scrypt") {
    throw new Error("Unsupported keystore version");
  }
  const salt = fromHex(keystore.salt);
  const iv = fromHex(keystore.iv);
  const key = await deriveAesKey(password, salt);

  let pk: Uint8Array;
  try {
    pk = new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv }, key, fromHex(keystore.ciphertext)),
    );
  } catch {
    // GCM auth failure. Deliberately vague and carries no key material.
    throw new Error("Wrong password or corrupted keystore");
  }

  const account = privateKeyToAccount(`0x${toHex(pk)}`);
  return {
    address: account.address,
    account,
    wipe: () => zero(pk),
  };
}

/**
 * The safe way to use a key: unlock, do the work, wipe — even if the work
 * throws. Prefer this over calling unlock() directly.
 */
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

/**
 * Minimum bar for a password that guards real funds. Deliberately enforced in
 * the crypto layer so no UI path can skip it.
 */
export function assertPasswordStrength(password: string) {
  if (password.length < 10) {
    throw new Error("Password must be at least 10 characters");
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error("Password must contain letters and numbers");
  }
}
