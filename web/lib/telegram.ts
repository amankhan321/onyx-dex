"use client";

import type { EncryptedKeystore } from "./keystore";

/**
 * Telegram Mini App bridge.
 *
 * SecureStorage (Bot API 9.0) is the primary home for the encrypted keystore:
 * it lives on the user's device, so the blob never needs to reach our server at
 * all. DeviceStorage holds non-sensitive preferences only.
 *
 * Nothing here ever transmits a password or a plaintext key — the only value
 * that crosses into Telegram's storage is the already-encrypted blob.
 */

type StorageCb<T> = (err: string | null, value: T | null) => void;

type TgWebApp = {
  initData: string;
  initDataUnsafe?: { user?: { id: number; username?: string; first_name?: string } };
  ready: () => void;
  expand: () => void;
  close: () => void;
  colorScheme?: "light" | "dark";
  SecureStorage?: {
    setItem: (k: string, v: string, cb?: StorageCb<boolean>) => void;
    getItem: (k: string, cb: StorageCb<string>) => void;
    removeItem: (k: string, cb?: StorageCb<boolean>) => void;
    restoreItem?: (k: string, cb: StorageCb<string>) => void;
  };
  DeviceStorage?: {
    setItem: (k: string, v: string, cb?: StorageCb<boolean>) => void;
    getItem: (k: string, cb: StorageCb<string>) => void;
  };
};

export function tg(): TgWebApp | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp ?? null;
}

export const inTelegram = () => tg() !== null;

/**
 * Which storage the encrypted blob will actually land in.
 *
 *  "secure"   — Telegram SecureStorage (Bot API 9.0+). OS-backed, isolated per
 *               app, survives reinstall via restoreItem. The intended path.
 *  "fallback" — plain localStorage, because the client is too old to expose
 *               SecureStorage (or we're in a normal browser). Readable by any
 *               script that runs on this origin and wiped by a routine
 *               "clear browsing data". Degraded, and the UI must say so.
 *
 * Deliberately a runtime probe rather than a version check: what matters is
 * whether the API is actually there.
 */
export type StorageMode = "secure" | "fallback";

export function storageMode(): StorageMode {
  const app = tg();
  return app?.SecureStorage ? "secure" : "fallback";
}

const KEYSTORE_KEY = "onyx_keystore_v1";

/** Promise wrapper — Telegram's storage API is callback-style. */
function p<T>(fn: (cb: StorageCb<T>) => void): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      fn((err, value) => resolve(err ? null : value));
    } catch {
      resolve(null);
    }
  });
}

/**
 * Persist the ENCRYPTED blob to device-local SecureStorage.
 * Falls back to localStorage only outside Telegram (browser dev), which is
 * flagged to the user in the UI so nobody mistakes it for the secure path.
 */
export async function saveKeystore(ks: EncryptedKeystore): Promise<boolean> {
  const blob = JSON.stringify(ks);
  const app = tg();
  if (app?.SecureStorage) {
    const ok = await p<boolean>((cb) => app.SecureStorage!.setItem(KEYSTORE_KEY, blob, cb));
    return ok !== null;
  }
  try {
    localStorage.setItem(KEYSTORE_KEY, blob);
    return true;
  } catch {
    return false;
  }
}

export async function loadKeystore(): Promise<EncryptedKeystore | null> {
  const app = tg();
  let raw: string | null = null;
  if (app?.SecureStorage) {
    raw = await p<string>((cb) => app.SecureStorage!.getItem(KEYSTORE_KEY, cb));
    // restoreItem recovers a blob after a reinstall on the same account.
    if (!raw && app.SecureStorage.restoreItem) {
      raw = await p<string>((cb) => app.SecureStorage!.restoreItem!(KEYSTORE_KEY, cb));
    }
  } else {
    try {
      raw = localStorage.getItem(KEYSTORE_KEY);
    } catch {
      raw = null;
    }
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EncryptedKeystore;
  } catch {
    return null;
  }
}

export async function clearKeystore(): Promise<void> {
  const app = tg();
  if (app?.SecureStorage) {
    await p<boolean>((cb) => app.SecureStorage!.removeItem(KEYSTORE_KEY, cb));
    return;
  }
  try {
    localStorage.removeItem(KEYSTORE_KEY);
  } catch {
    /* nothing to do */
  }
}

/** Non-sensitive prefs only — never key material. */
export async function savePref(key: string, value: string) {
  const app = tg();
  if (app?.DeviceStorage) {
    await p<boolean>((cb) => app.DeviceStorage!.setItem(key, value, cb));
    return;
  }
  try {
    localStorage.setItem(`pref_${key}`, value);
  } catch {
    /* nothing to do */
  }
}
