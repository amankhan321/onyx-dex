"use client";

/**
 * Device-local record of every transaction this Mini App submits.
 *
 * Written at BROADCAST time, not on confirmation. A record created only after
 * success would erase exactly the transactions a user most needs to see — the
 * pending one they are waiting on, and the failed one they need to understand.
 *
 * Deliberately not getLogs: that stays banned in the Mini App. This is a record
 * of what WE sent, which is both cheaper and more complete than reconstructing
 * it from chain events, since it includes attempts that never landed.
 *
 * Public data only — hashes, amounts, labels. Never key material.
 */

export type ActivityKind =
  | "swap"
  | "approve"
  | "limit"
  | "cancel-order"
  | "cancel-twap"
  | "claim"
  | "twap"
  | "deposit"
  | "withdraw";

export type ActivityStatus = "pending" | "confirmed" | "failed" | "unknown";

export type ActivityEntry = {
  hash: string;
  kind: ActivityKind;
  /** One line describing what was done, e.g. "1.5 USDC → 1.7 EURC". */
  summary: string;
  /** Broadcast time, ms. */
  at: number;
  status: ActivityStatus;
  /** Mapped, human error for a failed entry — never a raw revert string. */
  error?: string;
  /** Set once we stop asking; an unresolved hash reads "unknown", not "failed". */
  resolvedAt?: number;
};

const KEY = (addr: string) => `onyx-activity-${addr.toLowerCase()}`;
const MAX_ENTRIES = 100;

export function loadActivity(address: string): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(KEY(address));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActivityEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(address: string, entries: ActivityEntry[]) {
  try {
    localStorage.setItem(KEY(address), JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* the log is a convenience; losing it must never break a transaction */
  }
}

/** Record a broadcast. Newest first, de-duplicated by hash. */
export function recordActivity(
  address: string,
  entry: Omit<ActivityEntry, "status" | "at"> & Partial<Pick<ActivityEntry, "status" | "at">>,
): ActivityEntry[] {
  const existing = loadActivity(address).filter((e) => e.hash !== entry.hash);
  const next: ActivityEntry[] = [
    { at: Date.now(), status: "pending", ...entry },
    ...existing,
  ];
  write(address, next);
  return next;
}

export function updateActivity(
  address: string,
  hash: string,
  patch: Partial<ActivityEntry>,
): ActivityEntry[] {
  const next = loadActivity(address).map((e) => (e.hash === hash ? { ...e, ...patch } : e));
  write(address, next);
  return next;
}

/**
 * Give up asking after this long and mark the entry "unknown".
 *
 * A receipt we never see is not a failure — the transaction may well have
 * succeeded on a node we did not reach. Calling it failed would be a guess, and
 * a guess about someone's money is worse than admitting we don't know.
 */
export const RESOLVE_TIMEOUT_MS = 10 * 60 * 1000;

export const isUnresolved = (e: ActivityEntry) =>
  e.status === "pending" && Date.now() - e.at < RESOLVE_TIMEOUT_MS;

export const shouldGiveUp = (e: ActivityEntry) =>
  e.status === "pending" && Date.now() - e.at >= RESOLVE_TIMEOUT_MS;

const LABELS: Record<ActivityKind, string> = {
  swap: "Swap",
  approve: "Approval",
  limit: "Limit order",
  "cancel-order": "Cancel order",
  "cancel-twap": "Cancel TWAP",
  claim: "Claim",
  twap: "TWAP",
  deposit: "Deposit",
  withdraw: "Withdraw",
};

export const kindLabel = (k: ActivityKind) => LABELS[k] ?? "Transaction";

/** "2m ago" reads better than a timestamp for recent activity. */
export function relativeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
