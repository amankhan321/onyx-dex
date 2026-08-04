import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createIntent,
  consumeIntent,
  memoryStore,
  newIntentId,
  INTENT_TTL_MS,
  type IntentStore,
} from "./intents.ts";
import type { TradePayload } from "./commands.ts";

const buy: TradePayload = {
  command: "buy",
  zeroForOne: true,
  tokenIn: "USDC",
  amount: "100",
  slippageBps: 50,
};

const T0 = 1_000_000_000_000;
const ALICE = 111;
const BOB = 222;

async function seed(store: IntentStore, telegramId = ALICE, now = T0) {
  return createIntent(store, { telegramId, payload: buy, now });
}

test("ids are opaque, URL-safe and unguessable-length", () => {
  const id = newIntentId();
  assert.match(id, /^[A-Za-z0-9_-]+$/); // base64url, no +/= that would break a URL
  assert.ok(id.length >= 20);
  assert.notEqual(newIntentId(), newIntentId());
});

test("a fresh intent consumes once for its creator and returns the payload", async () => {
  const store = memoryStore();
  const { id } = await seed(store);
  const r = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + 1000 });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.payload, buy);
});

test("INVARIANT: an intent cannot be replayed (single use)", async () => {
  const store = memoryStore();
  const { id } = await seed(store);
  const first = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + 1 });
  assert.equal(first.ok, true);
  const second = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + 2 });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "consumed");
});

test("INVARIANT: a concurrent double-tap only wins once", async () => {
  const store = memoryStore();
  const { id } = await seed(store);
  const [a, b] = await Promise.all([
    consumeIntent(store, { id, telegramId: ALICE, now: T0 + 1 }),
    consumeIntent(store, { id, telegramId: ALICE, now: T0 + 1 }),
  ]);
  const wins = [a, b].filter((r) => r.ok).length;
  assert.equal(wins, 1);
});

test("INVARIANT: another Telegram user cannot use your intent", async () => {
  const store = memoryStore();
  const { id } = await seed(store, ALICE);
  const r = await consumeIntent(store, { id, telegramId: BOB, now: T0 + 1 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "wrong-user");
  // And it is still spendable by its real owner afterwards (the probe didn't consume it).
  const owner = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + 2 });
  assert.equal(owner.ok, true);
});

test("INVARIANT: an intent cannot be signed after it expires", async () => {
  const store = memoryStore();
  const { id } = await seed(store, ALICE, T0);
  const justAfter = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + INTENT_TTL_MS + 1 });
  assert.equal(justAfter.ok, false);
  if (!justAfter.ok) assert.equal(justAfter.reason, "expired");
});

test("expiry boundary: consumable at the last valid ms, not one past", async () => {
  const store = memoryStore();
  const { id } = await seed(store, ALICE, T0);
  const atEdge = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + INTENT_TTL_MS });
  assert.equal(atEdge.ok, true);
});

test("an expired intent is never revived by a later in-window clock (already consumed stays consumed)", async () => {
  const store = memoryStore();
  const { id } = await seed(store, ALICE, T0);
  await consumeIntent(store, { id, telegramId: ALICE, now: T0 + 1 }); // consume in-window
  const later = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + 2 });
  assert.equal(later.ok, false);
  if (!later.ok) assert.equal(later.reason, "consumed");
});

test("unknown id fails closed", async () => {
  const store = memoryStore();
  const r = await consumeIntent(store, { id: "does-not-exist", telegramId: ALICE, now: T0 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "not-found");
});

test("wrong-user and not-found are indistinguishable to a prober", async () => {
  // Both map to the same user-facing message, so an attacker can't enumerate ids.
  const { consumeErrorMessage } = await import("./intents.ts");
  assert.equal(consumeErrorMessage("wrong-user"), consumeErrorMessage("not-found"));
});

test("payload stored is params only — no built transaction or key material", async () => {
  const store = memoryStore();
  const { id } = await seed(store);
  const got = await store.get(id);
  const json = JSON.stringify(got);
  assert.ok(!/rawTransaction|privateKey|mnemonic|signature|\bseed\b/i.test(json));
});
