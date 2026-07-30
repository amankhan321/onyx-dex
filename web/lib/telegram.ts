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

type MainButton = {
  text: string;
  isVisible: boolean;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
  setText: (t: string) => void;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
  setParams: (p: { text?: string; color?: string; text_color?: string; is_active?: boolean; is_visible?: boolean }) => void;
};

type BackButton = {
  isVisible: boolean;
  show: () => void;
  hide: () => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
};

type TgWebApp = {
  initData: string;
  version?: string;
  platform?: string;
  viewportStableHeight?: number;
  viewportHeight?: number;
  isExpanded?: boolean;
  MainButton?: MainButton;
  BackButton?: BackButton;
  HapticFeedback?: {
    impactOccurred: (style: "light" | "medium" | "heavy" | "rigid" | "soft") => void;
    notificationOccurred: (type: "error" | "success" | "warning") => void;
    selectionChanged: () => void;
  };
  onEvent?: (event: string, cb: () => void) => void;
  offEvent?: (event: string, cb: () => void) => void;
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
  CloudStorage?: {
    setItem: (k: string, v: string, cb?: StorageCb<boolean>) => void;
    getItem: (k: string, cb: StorageCb<string>) => void;
    removeItem: (k: string, cb?: StorageCb<boolean>) => void;
    getKeys?: (cb: StorageCb<string[]>) => void;
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
 * Wait for the Telegram SDK to attach.
 *
 * The script is loaded beforeInteractive, but a webview can still attach
 * window.Telegram a tick late. Computing tiers before then reports "no
 * SecureStorage" on a perfectly capable client and latches the degraded banner
 * and the 100 USDC cap for the whole session. Polling briefly costs nothing and
 * removes a whole class of false negatives.
 */
export function waitForTelegram(timeoutMs = 2000): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (tg()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const id = setInterval(() => {
      if (tg()) {
        clearInterval(id);
        resolve(true);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(id);
        resolve(false);
      }
    }, 50);
  });
}

/** Version, platform and detected tiers — for the diagnostics row. No secrets. */
export function telegramDiagnostics() {
  const app = tg();
  const tiers = tiersAvailable();
  return {
    present: Boolean(app),
    version: app?.version ?? "—",
    platform: app?.platform ?? "unknown",
    secure: tiers.secure,
    cloud: tiers.cloud,
    local: tiers.local,
  };
}

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

const KEYSTORE_KEY = "onyx_keystore_v1";

/** Promise wrapper — Telegram's storage APIs are callback-style. */
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
 * THREE-TIER KEYSTORE STORAGE.
 *
 * The bug this replaces: storage was device-local only, so a new phone, a fresh
 * Telegram login, or a cleared webview dropped the user back to "Set up your
 * wallet" — and anyone who hadn't written down their seed phrase lost the
 * wallet outright. A missed tier looked identical to having no wallet.
 *
 *   secure → Telegram SecureStorage. Device-local, OS-backed. Fast, preferred.
 *   cloud  → Telegram CloudStorage. Synced to the Telegram ACCOUNT, so it
 *            survives changing phones. Opt-in.
 *   local  → localStorage. Last resort, and capped (see the 100 USDC limit),
 *            because any script on this origin can read it.
 *
 * Only ever the ENCRYPTED blob. The password is not written to any tier, ever,
 * and without it every tier holds ciphertext that is useless.
 *
 * Cloud limits are 4096 bytes per key; our blob is ~300 bytes, so it fits with
 * room to spare.
 */
export type StorageTier = "secure" | "cloud" | "local";

export function tiersAvailable(): Record<StorageTier, boolean> {
  const app = tg();
  return {
    secure: Boolean(app?.SecureStorage),
    cloud: Boolean(app?.CloudStorage),
    local: typeof localStorage !== "undefined",
  };
}

/**
 * Which tier a NEW write would land in if cloud isn't opted into. Drives the
 * "less-secure storage" banner and the transaction cap.
 */
export function storageMode(): "secure" | "fallback" {
  return tiersAvailable().secure ? "secure" : "fallback";
}

export type TierRead =
  | { status: "value"; raw: string }
  | { status: "empty" }
  | { status: "unsupported" }
  | { status: "error"; reason: string };

/**
 * Does this error mean "this client can't do that" rather than "that failed"?
 *
 * This distinction is the whole bug: Telegram exposes the SecureStorage and
 * CloudStorage objects on clients that don't actually implement the methods, so
 * a feature check on the property passes and the CALL then fails with
 * WebAppMethodUnsupported. Treating that as an error produced a retry screen
 * that could never succeed — the method will never become supported on that
 * client. Unsupported is a permanent, expected state, not a failure.
 */
function isUnsupported(err: unknown): boolean {
  const s = String(err);
  return /unsupported|not\s*supported|unknown method|WebAppMethodUnsupported/i.test(s);
}

/**
 * Promise wrapper preserving the FOUR outcomes.
 *
 * Telegram calls back with (err, value):
 *   err mentions unsupported → this client lacks the method entirely
 *   err otherwise            → present but failed: offline, rate-limited
 *   no err, empty value      → definitively nothing stored
 *   no err, value            → found
 */
function pRead(fn: (cb: StorageCb<string>) => void): Promise<TierRead> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: TierRead) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const timer = setTimeout(() => done({ status: "error", reason: "timed out" }), 8000);
    try {
      fn((err, value) => {
        clearTimeout(timer);
        if (err) {
          return done(
            isUnsupported(err)
              ? { status: "unsupported" }
              : { status: "error", reason: String(err).slice(0, 120) },
          );
        }
        if (value === null || value === undefined || value === "") return done({ status: "empty" });
        done({ status: "value", raw: value });
      });
    } catch (e) {
      clearTimeout(timer);
      // A synchronous throw from a missing method is also just unsupported.
      done(
        isUnsupported(e)
          ? { status: "unsupported" }
          : { status: "error", reason: e instanceof Error ? e.message.slice(0, 120) : "threw" },
      );
    }
  });
}

async function readSecureTier(): Promise<TierRead> {
  const app = tg();
  if (!app?.SecureStorage) return { status: "unsupported" };
  const first = await pRead((cb) => app.SecureStorage!.getItem(KEYSTORE_KEY, cb));
  if (first.status !== "empty") return first;
  if (app.SecureStorage.restoreItem) {
    const restored = await pRead((cb) => app.SecureStorage!.restoreItem!(KEYSTORE_KEY, cb));
    // A failed restore of a key we already know is absent is still just absent.
    return restored.status === "value" ? restored : { status: "empty" };
  }
  return { status: "empty" };
}

async function readCloudTier(): Promise<TierRead> {
  const app = tg();
  if (!app?.CloudStorage) return { status: "unsupported" };
  return pRead((cb) => app.CloudStorage!.getItem(KEYSTORE_KEY, cb));
}

function readLocalTier(): TierRead {
  try {
    const v = localStorage.getItem(KEYSTORE_KEY);
    return v ? { status: "value", raw: v } : { status: "empty" };
  } catch (e) {
    return { status: "error", reason: e instanceof Error ? e.message.slice(0, 120) : "unavailable" };
  }
}

async function readSecure(): Promise<string | null> {
  const app = tg();
  if (!app?.SecureStorage) return null;
  let raw = await p<string>((cb) => app.SecureStorage!.getItem(KEYSTORE_KEY, cb));
  // restoreItem recovers a blob after an app reinstall on the same account.
  if (!raw && app.SecureStorage.restoreItem) {
    raw = await p<string>((cb) => app.SecureStorage!.restoreItem!(KEYSTORE_KEY, cb));
  }
  return raw;
}

async function readCloud(): Promise<string | null> {
  const app = tg();
  if (!app?.CloudStorage) return null;
  return p<string>((cb) => app.CloudStorage!.getItem(KEYSTORE_KEY, cb));
}

function readLocal(): string | null {
  try {
    return localStorage.getItem(KEYSTORE_KEY);
  } catch {
    return null;
  }
}

/**
 * Resolve the keystore across all tiers, first hit wins.
 *
 * A CloudStorage hit is written through to SecureStorage so subsequent opens
 * are instant and work offline.
 *
 * Returns null ONLY when all three tiers are genuinely empty — that is the sole
 * condition under which the UI may show "Set up your wallet".
 */
export async function loadKeystore(): Promise<EncryptedKeystore | null> {
  const r = await resolveKeystoreDetailed();
  return r.status === "found" ? r.keystore : null;
}

export type Resolution =
  | {
      status: "found";
      keystore: EncryptedKeystore;
      tier: StorageTier;
      /** Tiers that failed while a usable copy was found elsewhere. Non-blocking. */
      degraded: { tier: StorageTier; reason: string }[];
    }
  | {
      status: "empty";
      /** True when neither durable tier exists on this client. */
      durableUnsupported: boolean;
    }
  | { status: "error"; failures: { tier: StorageTier; reason: string }[] };

const parseBlob = (raw: string): EncryptedKeystore | null => {
  try {
    const v = JSON.parse(raw);
    return v && (v.version === 1 || v.version === 2) && v.ciphertext ? (v as EncryptedKeystore) : null;
  } catch {
    return null;
  }
};

const epochOf = (k: EncryptedKeystore) => (typeof k.epoch === "number" ? k.epoch : 0);

async function writeTier(tier: StorageTier, blob: string): Promise<void> {
  const app = tg();
  try {
    if (tier === "secure" && app?.SecureStorage) {
      await p<boolean>((cb) => app.SecureStorage!.setItem(KEYSTORE_KEY, blob, cb));
    } else if (tier === "cloud" && app?.CloudStorage) {
      await p<boolean>((cb) => app.CloudStorage!.setItem(KEYSTORE_KEY, blob, cb));
    } else if (tier === "local") {
      localStorage.setItem(KEYSTORE_KEY, blob);
    }
  } catch {
    /* healing is best-effort; a failure here must never block boot */
  }
}

/**
 * Resolve the wallet across every tier.
 *
 * Boot rule, in order of importance:
 *  1. If ANY tier produced a usable blob, boot. Other tiers being unsupported or
 *     failing is irrelevant — a working cloud copy is sufficient on its own.
 *  2. Retry is shown ONLY when a SUPPORTED tier errored and nothing produced a
 *     value. An unsupported method can never start working, so it must never
 *     lead to a retry button.
 *  3. Otherwise the wallet genuinely isn't here and setup is correct.
 *
 * All tiers are read in parallel rather than first-hit-wins, because they can
 * disagree: a partially-failed multi-tier write leaves an old blob somewhere,
 * and booting from a stale one would reject the user's correct current password.
 * The highest epoch wins and the others are healed toward it.
 */
export async function resolveKeystoreDetailed(): Promise<Resolution> {
  const [secure, cloud, local] = await Promise.all([
    readSecureTier(),
    readCloudTier(),
    Promise.resolve(readLocalTier()),
  ]);

  const reads: [StorageTier, TierRead][] = [
    ["secure", secure],
    ["cloud", cloud],
    ["local", local],
  ];

  const failures: { tier: StorageTier; reason: string }[] = [];
  const candidates: { tier: StorageTier; keystore: EncryptedKeystore }[] = [];

  for (const [tier, res] of reads) {
    if (res.status === "error") failures.push({ tier, reason: res.reason });
    else if (res.status === "value") {
      const ks = parseBlob(res.raw);
      if (ks) candidates.push({ tier, keystore: ks });
      // Bytes that exist but don't parse are a real failure, not an absence.
      else failures.push({ tier, reason: "stored data could not be read" });
    }
  }

  if (candidates.length > 0) {
    // Highest epoch wins; ties prefer the earlier (faster, more local) tier.
    const order: StorageTier[] = ["secure", "cloud", "local"];
    candidates.sort((a, b) => {
      const d = epochOf(b.keystore) - epochOf(a.keystore);
      return d !== 0 ? d : order.indexOf(a.tier) - order.indexOf(b.tier);
    });
    const winner = candidates[0];
    const blob = JSON.stringify(winner.keystore);

    // Heal every tier that is missing this blob or holds an older epoch. Silent
    // and best-effort — the user is already booting.
    void (async () => {
      for (const [tier, res] of reads) {
        if (tier === winner.tier) continue;
        const existing = candidates.find((c) => c.tier === tier);
        const stale = existing ? epochOf(existing.keystore) < epochOf(winner.keystore) : res.status === "empty";
        if (stale) await writeTier(tier, blob);
      }
    })();

    return { status: "found", keystore: winner.keystore, tier: winner.tier, degraded: failures };
  }

  // Nothing found. Only a SUPPORTED tier's failure justifies blocking.
  if (failures.length > 0) return { status: "error", failures };

  const durableUnsupported = secure.status === "unsupported" && cloud.status === "unsupported";
  return { status: "empty", durableUnsupported };
}

export async function resolveKeystore(): Promise<{ keystore: EncryptedKeystore; tier: StorageTier } | null> {
  const r = await resolveKeystoreDetailed();
  return r.status === "found" ? { keystore: r.keystore, tier: r.tier } : null;
}

async function _unusedResolve(): Promise<{ keystore: EncryptedKeystore; tier: StorageTier } | null> {
  const parse = (raw: string | null): EncryptedKeystore | null => {
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      return v && v.version === 1 && v.ciphertext ? (v as EncryptedKeystore) : null;
    } catch {
      return null;
    }
  };

  const secure = parse(await readSecure());
  if (secure) return { keystore: secure, tier: "secure" };

  const cloud = parse(await readCloud());
  if (cloud) {
    // Write through so the next open doesn't need the network.
    const app = tg();
    if (app?.SecureStorage) {
      await p<boolean>((cb) => app.SecureStorage!.setItem(KEYSTORE_KEY, JSON.stringify(cloud), cb));
    }
    return { keystore: cloud, tier: "cloud" };
  }

  const local = parse(readLocal());
  if (local) return { keystore: local, tier: "local" };

  return null;
}

/**
 * Persist the encrypted blob. Always writes the best available local tier;
 * writes to the cloud only when the user has opted in.
 */
export async function saveKeystore(
  ks: EncryptedKeystore,
  opts: { cloud?: boolean } = {},
): Promise<{ secure: boolean; cloud: boolean; local: boolean }> {
  const blob = JSON.stringify(ks);
  const app = tg();
  const wrote = { secure: false, cloud: false, local: false };

  if (app?.SecureStorage) {
    wrote.secure = (await p<boolean>((cb) => app.SecureStorage!.setItem(KEYSTORE_KEY, blob, cb))) !== null;
  }
  if (opts.cloud && app?.CloudStorage) {
    wrote.cloud = (await p<boolean>((cb) => app.CloudStorage!.setItem(KEYSTORE_KEY, blob, cb))) !== null;
  }
  if (!wrote.secure) {
    try {
      localStorage.setItem(KEYSTORE_KEY, blob);
      wrote.local = true;
    } catch {
      /* nothing else to try */
    }
  }
  return wrote;
}

/** Back up an existing wallet to the cloud after the fact (settings toggle). */
export async function backupToCloud(ks: EncryptedKeystore): Promise<boolean> {
  const app = tg();
  if (!app?.CloudStorage) return false;
  const ok = await p<boolean>((cb) => app.CloudStorage!.setItem(KEYSTORE_KEY, JSON.stringify(ks), cb));
  return ok !== null;
}

export async function isInCloud(): Promise<boolean> {
  return (await readCloud()) !== null;
}

/** Remove the cloud copy only. The device copy is untouched. */
export async function removeFromCloud(): Promise<boolean> {
  const app = tg();
  if (!app?.CloudStorage) return false;
  const ok = await p<boolean>((cb) => app.CloudStorage!.removeItem(KEYSTORE_KEY, cb));
  return ok !== null;
}

/**
 * Remove the wallet from THIS DEVICE only, leaving the Telegram cloud copy
 * intact so other devices — and this one, later — can still restore it.
 *
 * The previous single function wiped the cloud copy too while the button said
 * "from this device", which silently destroyed the backup everywhere.
 */
export async function clearKeystoreLocal(): Promise<void> {
  const app = tg();
  if (app?.SecureStorage) await p<boolean>((cb) => app.SecureStorage!.removeItem(KEYSTORE_KEY, cb));
  try {
    localStorage.removeItem(KEYSTORE_KEY);
  } catch {
    /* nothing to do */
  }
}

/**
 * Wipe EVERY tier including the Telegram cloud backup. Irreversible without the
 * recovery phrase, on every device. Only ever call this behind an explicit,
 * typed confirmation.
 */
export async function clearKeystore(): Promise<void> {
  const app = tg();
  if (app?.SecureStorage) await p<boolean>((cb) => app.SecureStorage!.removeItem(KEYSTORE_KEY, cb));
  if (app?.CloudStorage) await p<boolean>((cb) => app.CloudStorage!.removeItem(KEYSTORE_KEY, cb));
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


/**
 * Is this actually running inside Telegram with a real session?
 *
 * `initData` empty or a platform of "unknown" means the page was opened in a
 * plain browser. The UI must say so rather than render a half-working screen —
 * SecureStorage won't exist, and the user needs to know their key is landing in
 * the weaker store.
 */
export function telegramSession(): { inApp: boolean; platform: string; version: string } {
  const app = tg();
  const platform = app?.platform ?? "unknown";
  return {
    inApp: Boolean(app && app.initData && app.initData.length > 0 && platform !== "unknown"),
    platform,
    version: app?.version ?? "0",
  };
}

/** Raw initData, for server-side HMAC verification. Never a substitute for auth. */
export const initData = () => tg()?.initData ?? "";

/**
 * Usable height. Telegram's viewport shrinks when the keyboard opens;
 * viewportStableHeight excludes that, which is what layout should follow or the
 * bottom nav jumps around while typing.
 */
export function stableHeight(): number {
  const app = tg();
  return app?.viewportStableHeight ?? app?.viewportHeight ?? (typeof window !== "undefined" ? window.innerHeight : 0);
}

export function expand() {
  tg()?.expand();
}

export const haptic = {
  tap: () => tg()?.HapticFeedback?.impactOccurred("light"),
  confirm: () => tg()?.HapticFeedback?.impactOccurred("medium"),
  success: () => tg()?.HapticFeedback?.notificationOccurred("success"),
  error: () => tg()?.HapticFeedback?.notificationOccurred("error"),
  select: () => tg()?.HapticFeedback?.selectionChanged(),
};

export const mainButton = () => tg()?.MainButton ?? null;
export const backButton = () => tg()?.BackButton ?? null;


/**
 * The wallet's public address, cached so the app can render on open without
 * asking for a password. An address is public data — this is DeviceStorage
 * (non-sensitive), never SecureStorage, and never anything derived from a key.
 */
const ADDRESS_KEY = "onyx_address_v1";

export async function saveAddress(address: string) {
  const app = tg();
  if (app?.DeviceStorage) {
    await p<boolean>((cb) => app.DeviceStorage!.setItem(ADDRESS_KEY, address, cb));
    return;
  }
  try {
    localStorage.setItem(ADDRESS_KEY, address);
  } catch {
    /* nothing to do */
  }
}

export async function loadAddress(): Promise<`0x${string}` | null> {
  const app = tg();
  let v: string | null = null;
  if (app?.DeviceStorage) {
    v = await p<string>((cb) => app.DeviceStorage!.getItem(ADDRESS_KEY, cb));
  } else {
    try {
      v = localStorage.getItem(ADDRESS_KEY);
    } catch {
      v = null;
    }
  }
  return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as `0x${string}`) : null;
}
