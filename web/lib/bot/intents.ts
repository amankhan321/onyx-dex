/**
 * Trade intents — the untrusted hand-off from chat to the signing device.
 *
 * A signing command (/buy, /limit, …) is parsed in chat, then stored here under
 * a short OPAQUE id. The bot deep-links the Mini App with only that id
 * (t.me/<bot>/app?startapp=<id>) — never amounts, never addresses. The Mini App
 * reads the id from start_param, asks the server to consume it, RE-QUOTES and
 * RE-DERIVES every number on the device, shows exactly what it will sign, and
 * signs. The server never signs and never stores anything it could replay.
 *
 * The intent is untrusted input to the device. Consumption therefore fails
 * CLOSED on every abuse:
 *   - unknown id                     → not found
 *   - wrong Telegram user            → another user cannot spend your intent
 *   - already consumed               → single use, no replay
 *   - past its 5-minute expiry       → no silent re-price; the user re-quotes
 *
 * The pure policy (create/consume) is separated from any database so it can be
 * tested exhaustively with an in-memory store and an injectable clock. The Neon
 * adapter below implements the same StintStore interface for production.
 */

import { randomBytes } from "node:crypto";
import type { TradePayload } from "./commands";

/** Five minutes, in ms. The brief fixes this; do not lengthen it. */
export const INTENT_TTL_MS = 5 * 60 * 1000;

export type StoredIntent = {
  id: string;
  telegramId: number;
  payload: TradePayload;
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
};

export type ConsumeResult =
  | { ok: true; payload: TradePayload }
  | { ok: false; reason: "not-found" | "wrong-user" | "consumed" | "expired" };

/**
 * Storage the policy needs. Kept tiny so both an in-memory map (tests) and Neon
 * (production) can satisfy it. `markConsumed` MUST be atomic and return false if
 * the row was already consumed — that atomicity is what makes single-use hold
 * under concurrent taps.
 */
export interface IntentStore {
  put(intent: StoredIntent): Promise<void>;
  get(id: string): Promise<StoredIntent | null>;
  /** Atomically set consumedAt if currently null. Returns true iff this call won the race. */
  markConsumed(id: string, at: number): Promise<boolean>;
}

/** Opaque, URL-safe, unguessable. 128 bits is plenty and stays short in a URL. */
export function newIntentId(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Create and persist an intent. `payload` is trade PARAMETERS only — no built
 * transaction, no user key, nothing the server could act on itself.
 */
export async function createIntent(
  store: IntentStore,
  args: { telegramId: number; payload: TradePayload; now: number; id?: string },
): Promise<StoredIntent> {
  const intent: StoredIntent = {
    id: args.id ?? newIntentId(),
    telegramId: args.telegramId,
    payload: args.payload,
    createdAt: args.now,
    expiresAt: args.now + INTENT_TTL_MS,
    consumedAt: null,
  };
  await store.put(intent);
  return intent;
}

/**
 * Consume an intent for a specific Telegram user at time `now`. Every failure
 * mode returns a reason and changes nothing. Success marks it consumed
 * atomically before returning the payload, so a replay — even a concurrent one —
 * loses the race and gets `consumed`.
 */
export async function consumeIntent(
  store: IntentStore,
  args: { id: string; telegramId: number; now: number },
): Promise<ConsumeResult> {
  const intent = await store.get(args.id);
  if (!intent) return { ok: false, reason: "not-found" };

  // Bind to creator. Checked before expiry so a probing user can't distinguish
  // "someone else's, still valid" from "someone else's, expired".
  if (intent.telegramId !== args.telegramId) return { ok: false, reason: "wrong-user" };

  if (intent.consumedAt !== null) return { ok: false, reason: "consumed" };
  if (args.now > intent.expiresAt) return { ok: false, reason: "expired" };

  const won = await store.markConsumed(args.id, args.now);
  if (!won) return { ok: false, reason: "consumed" }; // lost a concurrent race

  return { ok: true, payload: intent.payload };
}

/** Human-readable, safe to show. Never leaks whether an id existed for someone else. */
export function consumeErrorMessage(reason: Exclude<ConsumeResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "expired":
      return "This trade request expired. Fresh prices matter — tap re-quote to get a new one.";
    case "consumed":
      return "This trade request was already used. Send the command again for a new one.";
    case "wrong-user":
    case "not-found":
      // Same message for both: a prober learns nothing about others' intents.
      return "That trade request isn't available. Send the command again to get a new one.";
  }
}

/** In-memory store — for tests and nothing else. Not durable across a restart. */
export function memoryStore(): IntentStore & { size: () => number } {
  const map = new Map<string, StoredIntent>();
  return {
    async put(i) {
      map.set(i.id, { ...i });
    },
    async get(id) {
      const i = map.get(id);
      return i ? { ...i } : null;
    },
    async markConsumed(id, at) {
      const i = map.get(id);
      if (!i || i.consumedAt !== null) return false;
      i.consumedAt = at;
      return true;
    },
    size: () => map.size,
  };
}
