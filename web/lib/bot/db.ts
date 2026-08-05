/**
 * FlowBot storage — Neon Postgres over HTTP.
 *
 * WHY POSTGRES OVER REDIS: the fill/alert watcher has to answer "every open
 * order across all users" on each sweep. That is one SELECT here; in a KV store
 * it becomes a key scan plus fan-out reads, which on a free tier's per-day
 * command budget is the first thing that would break. The existing schema also
 * ports across almost unchanged.
 *
 * Neon's HTTP driver is used deliberately: serverless functions have no stable
 * connection lifetime, so a pooled TCP driver leaks connections under load.
 *
 * WHAT MAY LIVE HERE: telegram_id, wallet ADDRESS, settings, order history.
 * WHAT MAY NEVER: a password, mnemonic, private key, or anything derived from
 * them. Keys live only on the user's device — the server cannot sign.
 */
import { neon } from "@neondatabase/serverless";
import type { IntentStore, StoredIntent } from "./intents";

/**
 * Lazily constructed.
 *
 * Building the client at module scope made `next build` fail: Next evaluates
 * route modules while collecting page data, when DATABASE_URL isn't present.
 * Deferring it to first use keeps the build independent of runtime secrets —
 * which is how it should be anyway.
 */
let client: ReturnType<typeof neon> | null = null;

function db() {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not configured");
    client = neon(url);
  }
  return client;
}

/** Idempotent: safe to call on every cold start. */
export async function ensureSchema() {
  await db()`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id  BIGINT PRIMARY KEY,
      username     TEXT,
      address      TEXT,
      referred_by  BIGINT,
      created_at   BIGINT NOT NULL
    )`;
  await db()`
    CREATE TABLE IF NOT EXISTS settings (
      telegram_id   BIGINT PRIMARY KEY,
      notifications BOOLEAN NOT NULL DEFAULT TRUE
    )`;
  await db()`
    CREATE TABLE IF NOT EXISTS tracked_orders (
      id          BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      order_id    TEXT NOT NULL,
      side        TEXT NOT NULL,
      price       TEXT NOT NULL,
      size        TEXT NOT NULL,
      tx_hash     TEXT,
      status      TEXT NOT NULL DEFAULT 'open',
      created_at  BIGINT NOT NULL
    )`;
  await db()`CREATE INDEX IF NOT EXISTS idx_orders_open ON tracked_orders(status)`;
  await db()`
    CREATE TABLE IF NOT EXISTS price_alerts (
      id           BIGSERIAL PRIMARY KEY,
      telegram_id  BIGINT NOT NULL,
      direction    TEXT NOT NULL,
      price        TEXT NOT NULL,
      created_at   BIGINT NOT NULL,
      triggered_at BIGINT
    )`;
  await db()`CREATE INDEX IF NOT EXISTS idx_alerts_active ON price_alerts(triggered_at)`;
  // Trade intents: the chat-to-device handoff. Holds trade PARAMETERS only —
  // never a built transaction, never anything the server could sign or replay.
  // consumed_at is set atomically so an intent is single-use under concurrency.
  await db()`
    CREATE TABLE IF NOT EXISTS trade_intents (
      id           TEXT PRIMARY KEY,
      telegram_id  BIGINT NOT NULL,
      payload      JSONB NOT NULL,
      created_at   BIGINT NOT NULL,
      expires_at   BIGINT NOT NULL,
      consumed_at  BIGINT
    )`;
  await db()`CREATE INDEX IF NOT EXISTS idx_intents_expiry ON trade_intents(expires_at)`;
}

/** This user's open orders, for /orders and for refusing an unmatched /cancel. */
export async function openOrdersFor(telegramId: number): Promise<TrackedOrder[]> {
  return (await db()`
    SELECT * FROM tracked_orders
    WHERE telegram_id = ${telegramId} AND status = 'open'
    ORDER BY created_at DESC LIMIT 50`) as TrackedOrder[];
}

export async function upsertUser(telegramId: number, username?: string, referredBy?: number) {
  await db()`
    INSERT INTO users (telegram_id, username, referred_by, created_at)
    VALUES (${telegramId}, ${username ?? null}, ${referredBy ?? null}, ${Date.now()})
    ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username`;
  await db()`
    INSERT INTO settings (telegram_id) VALUES (${telegramId})
    ON CONFLICT (telegram_id) DO NOTHING`;
}

/** Public address only — recorded so notifications can reach the right person. */
export async function setAddress(telegramId: number, address: string) {
  await db()`UPDATE users SET address = ${address} WHERE telegram_id = ${telegramId}`;
}

export async function getUser(telegramId: number) {
  const rows = (await db()`SELECT * FROM users WHERE telegram_id = ${telegramId}`) as Record<
    string,
    unknown
  >[];
  return rows[0];
}

export async function referralCount(telegramId: number): Promise<number> {
  const rows = (await db()`
    SELECT COUNT(*)::int AS n FROM users WHERE referred_by = ${telegramId}`) as { n: number }[];
  return rows[0]?.n ?? 0;
}

export type TrackedOrder = {
  id: number;
  telegram_id: number;
  order_id: string;
  side: string;
  price: string;
  size: string;
  tx_hash: string | null;
};

export async function openOrders(): Promise<TrackedOrder[]> {
  return (await db()`
    SELECT * FROM tracked_orders WHERE status = 'open' LIMIT 500`) as TrackedOrder[];
}

export async function markOrder(orderId: string, status: "filled" | "cancelled") {
  await db()`UPDATE tracked_orders SET status = ${status} WHERE order_id = ${orderId}`;
}

export type PriceAlert = { id: number; telegram_id: number; direction: string; price: string };

export async function activeAlerts(): Promise<PriceAlert[]> {
  return (await db()`
    SELECT * FROM price_alerts WHERE triggered_at IS NULL LIMIT 500`) as PriceAlert[];
}

export async function markAlertTriggered(id: number) {
  await db()`UPDATE price_alerts SET triggered_at = ${Date.now()} WHERE id = ${id}`;
}

export async function notificationsOn(telegramId: number): Promise<boolean> {
  const rows = (await db()`
    SELECT notifications FROM settings WHERE telegram_id = ${telegramId}`) as {
    notifications: boolean;
  }[];
  return rows[0]?.notifications ?? true;
}

/**
 * Neon-backed IntentStore (see lib/bot/intents.ts for the policy and its tests).
 *
 * markConsumed does the whole check-and-set in ONE statement:
 *   UPDATE ... WHERE id = $1 AND consumed_at IS NULL RETURNING id
 * so two concurrent taps cannot both win. Doing it as SELECT-then-UPDATE would
 * let a replay slip through between the two, which is the single most important
 * property of the intent system.
 */
export const intentStore: IntentStore = {
  async put(i) {
    await db()`
      INSERT INTO trade_intents (id, telegram_id, payload, created_at, expires_at, consumed_at)
      VALUES (${i.id}, ${i.telegramId}, ${JSON.stringify(i.payload)}, ${i.createdAt}, ${i.expiresAt}, NULL)`;
  },
  async get(id) {
    const rows = (await db()`
      SELECT * FROM trade_intents WHERE id = ${id}`) as {
      id: string;
      telegram_id: string | number;
      payload: unknown;
      created_at: string | number;
      expires_at: string | number;
      consumed_at: string | number | null;
    }[];
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      telegramId: Number(r.telegram_id),
      payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as StoredIntent["payload"],
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      consumedAt: r.consumed_at === null ? null : Number(r.consumed_at),
    };
  },
  async markConsumed(id, at) {
    const rows = (await db()`
      UPDATE trade_intents SET consumed_at = ${at}
      WHERE id = ${id} AND consumed_at IS NULL
      RETURNING id`) as { id: string }[];
    return rows.length === 1;
  },
};

/** Housekeeping: expired intents carry no secrets but need not accumulate. */
export async function pruneIntents(now: number) {
  await db()`DELETE FROM trade_intents WHERE expires_at < ${now - 86_400_000}`;
}
