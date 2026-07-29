/**
 * scrypt off the main thread.
 *
 * At N=2^17 the derivation needs ~128 MB and several seconds. Run on the main
 * thread it freezes the page — the tab stops painting, the button doesn't
 * respond, and users conclude it crashed and tap again. Moving it here keeps
 * the UI alive so a spinner can actually spin.
 *
 * Only the password and salt come in and a derived key goes out. The private
 * key never enters this worker.
 */
import { scrypt } from "@noble/hashes/scrypt.js";

type Job = {
  password: string;
  salt: Uint8Array;
  params: { N: number; r: number; p: number; dkLen: number };
};

self.onmessage = (e: MessageEvent<Job>) => {
  const { password, salt, params } = e.data;
  try {
    const pw = new TextEncoder().encode(password.normalize("NFKC"));
    const dk = scrypt(pw, salt, params);
    pw.fill(0); // don't leave the password bytes sitting in worker memory
    // Transfer rather than copy, so the worker's view is detached immediately.
    (self as unknown as Worker).postMessage({ ok: true, dk }, [dk.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : "derivation failed",
    });
  }
};
