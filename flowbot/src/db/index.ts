/**
 * Database access. Thin, synchronous, SQLite by default.
 *
 * Every function here is auditable against one rule: nothing in this file may
 * accept or return a password, mnemonic, or plaintext key. Keystore backups are
 * handled as opaque strings we have no means to decrypt.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Settings = {
  slippageBps: number;
  defaultAmounts: number[];
  notifications: boolean;
};

export type TrackedOrder = {
  id: number;
  telegramId: number;
  orderId: string;
  side: "bid" | "ask";
  price: string;
  size: string;
  txHash: string | null;
  status: "open" | "filled" | "cancelled";
};

let db: Database.Database;

export function initDb(url: string) {
  const file = url.startsWith("file:") ? url.slice(5) : url;
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));
  return db;
}

export function upsertUser(telegramId: number, username?: string, referredBy?: number) {
  db.prepare(
    `INSERT INTO users (telegram_id, username, created_at, referred_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username`,
  ).run(telegramId, username ?? null, Date.now(), referredBy ?? null);

  db.prepare(`INSERT OR IGNORE INTO settings (telegram_id) VALUES (?)`).run(telegramId);
}

/** Public address only — recorded so menus can show a balance without a round trip. */
export function setAddress(telegramId: number, address: string) {
  db.prepare(`UPDATE users SET address = ? WHERE telegram_id = ?`).run(address, telegramId);
}

export function getUser(telegramId: number) {
  return db.prepare(`SELECT * FROM users WHERE telegram_id = ?`).get(telegramId) as
    | { telegram_id: number; username: string | null; address: string | null; referred_by: number | null }
    | undefined;
}

export function getSettings(telegramId: number): Settings {
  const row = db.prepare(`SELECT * FROM settings WHERE telegram_id = ?`).get(telegramId) as
    | { slippage_bps: number; default_amounts: string; notifications: number }
    | undefined;
  return {
    slippageBps: row?.slippage_bps ?? 50,
    defaultAmounts: (row?.default_amounts ?? "10,50,100").split(",").map(Number),
    notifications: (row?.notifications ?? 1) === 1,
  };
}

export function updateSettings(telegramId: number, patch: Partial<Settings>) {
  const cur = getSettings(telegramId);
  const next = { ...cur, ...patch };
  db.prepare(
    `UPDATE settings SET slippage_bps = ?, default_amounts = ?, notifications = ?
     WHERE telegram_id = ?`,
  ).run(
    next.slippageBps,
    next.defaultAmounts.join(","),
    next.notifications ? 1 : 0,
    telegramId,
  );
}

/**
 * Opt-in backup of the ENCRYPTED blob. We store a string we cannot read; the
 * password that would open it never reaches this process.
 */
export function putKeystoreBackup(telegramId: number, blob: string) {
  db.prepare(
    `INSERT INTO keystore_backups (telegram_id, blob, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(telegram_id) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
  ).run(telegramId, blob, Date.now());
}

export function getKeystoreBackup(telegramId: number): string | null {
  const row = db.prepare(`SELECT blob FROM keystore_backups WHERE telegram_id = ?`).get(telegramId) as
    | { blob: string }
    | undefined;
  return row?.blob ?? null;
}

export function deleteKeystoreBackup(telegramId: number) {
  db.prepare(`DELETE FROM keystore_backups WHERE telegram_id = ?`).run(telegramId);
}

export function trackOrder(o: Omit<TrackedOrder, "id" | "status">) {
  db.prepare(
    `INSERT INTO tracked_orders (telegram_id, order_id, side, price, size, tx_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.telegramId, o.orderId, o.side, o.price, o.size, o.txHash ?? null, Date.now());
}

export function openOrders(telegramId?: number): TrackedOrder[] {
  const rows = telegramId
    ? db.prepare(`SELECT * FROM tracked_orders WHERE status='open' AND telegram_id=?`).all(telegramId)
    : db.prepare(`SELECT * FROM tracked_orders WHERE status='open'`).all();
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as number,
    telegramId: r.telegram_id as number,
    orderId: r.order_id as string,
    side: r.side as "bid" | "ask",
    price: r.price as string,
    size: r.size as string,
    txHash: (r.tx_hash as string) ?? null,
    status: r.status as TrackedOrder["status"],
  }));
}

export function markOrder(orderId: string, status: TrackedOrder["status"]) {
  db.prepare(
    `UPDATE tracked_orders SET status = ?, notified_at = ? WHERE order_id = ?`,
  ).run(status, Date.now(), orderId);
}

export function recordTrade(telegramId: number, kind: string, detail: string, txHash?: string) {
  db.prepare(
    `INSERT INTO trades (telegram_id, kind, detail, tx_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(telegramId, kind, detail, txHash ?? null, Date.now());
}

export function recentTrades(telegramId: number, limit = 10) {
  return db
    .prepare(`SELECT * FROM trades WHERE telegram_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(telegramId, limit) as { kind: string; detail: string; tx_hash: string | null; created_at: number }[];
}

export function referralCount(telegramId: number): number {
  const r = db.prepare(`SELECT COUNT(*) as n FROM users WHERE referred_by = ?`).get(telegramId) as { n: number };
  return r.n;
}

export type PriceAlert = {
  id: number;
  telegramId: number;
  direction: "above" | "below";
  price: number;
};

export function addAlert(telegramId: number, direction: "above" | "below", price: number) {
  db.prepare(
    `INSERT INTO price_alerts (telegram_id, direction, price, created_at) VALUES (?, ?, ?, ?)`,
  ).run(telegramId, direction, String(price), Date.now());
}

export function activeAlerts(telegramId?: number): PriceAlert[] {
  const rows = telegramId
    ? db
        .prepare(`SELECT * FROM price_alerts WHERE triggered_at IS NULL AND telegram_id = ?`)
        .all(telegramId)
    : db.prepare(`SELECT * FROM price_alerts WHERE triggered_at IS NULL`).all();
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r.id as number,
    telegramId: r.telegram_id as number,
    direction: r.direction as "above" | "below",
    price: Number(r.price),
  }));
}

export function markAlertTriggered(id: number) {
  db.prepare(`UPDATE price_alerts SET triggered_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function deleteAlert(telegramId: number, id: number) {
  db.prepare(`DELETE FROM price_alerts WHERE id = ? AND telegram_id = ?`).run(id, telegramId);
}
