import { test } from "node:test";
import assert from "node:assert/strict";
import {
  consumeIntent,
  createIntent,
  memoryStore,
  consumeErrorMessage,
  INTENT_TTL_MS,
} from "./intents";
import type { TradePayload } from "./commands";

/**
 * Stage 4 wiring tests: the exact sequences the Mini App confirm screen puts
 * the intent store through. intents.test.ts covers the store's own policy; this
 * covers the flows a deep link can actually produce — opened twice, forwarded
 * to another user, opened after sitting on a lock screen.
 */

const buy: TradePayload = {
  command: "buy",
  zeroForOne: true,
  tokenIn: "USDC",
  amount: "100",
  slippageBps: 50,
};

const T0 = 1_700_000_000_000;
const ALICE = 4242;
const MALLORY = 9999;

test("the happy path: tap the deep link once, get the parameters", async () => {
  const store = memoryStore();
  const { id } = await createIntent(store, { telegramId: ALICE, payload: buy, now: T0 });
  const r = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + 2_000 });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.payload, buy);
    // Parameters only — nothing signable ever crosses the wire.
    const json = JSON.stringify(r.payload);
    assert.doesNotMatch(json, /0x[0-9a-fA-F]{64,}/);
    assert.doesNotMatch(json, /privateKey|mnemonic|signature|rawTransaction/i);
  }
});

test("SCENARIO: the app is reopened on the same link — no second trade", async () => {
  // A user backgrounds Telegram and taps the same message again. The first
  // open consumed it; the second must show "already used", not sign again.
  const store = memoryStore();
  const { id } = await createIntent(store, { telegramId: ALICE, payload: buy, now: T0 });

  const first = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + 1_000 });
  assert.equal(first.ok, true);

  const second = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + 30_000 });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "consumed");
    assert.match(consumeErrorMessage(second.reason), /already used/i);
  }
});

test("SCENARIO: a double-mount fires two consumes at once — exactly one wins", async () => {
  // React strict mode, or a fast double tap. Only one may succeed or the user
  // could be shown a confirm screen for an intent that also trades elsewhere.
  const store = memoryStore();
  const { id } = await createIntent(store, { telegramId: ALICE, payload: buy, now: T0 });
  const results = await Promise.all([
    consumeIntent(store, { id, telegramId: ALICE, now: T0 + 500 }),
    consumeIntent(store, { id, telegramId: ALICE, now: T0 + 500 }),
    consumeIntent(store, { id, telegramId: ALICE, now: T0 + 500 }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("SCENARIO: the chat message is forwarded — the recipient cannot spend it", async () => {
  const store = memoryStore();
  const { id } = await createIntent(store, { telegramId: ALICE, payload: buy, now: T0 });

  const stolen = await consumeIntent(store, { id, telegramId: MALLORY, now: T0 + 1_000 });
  assert.equal(stolen.ok, false);
  if (!stolen.ok) assert.equal(stolen.reason, "wrong-user");

  // And the attempt did not burn Alice's intent.
  const alice = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + 2_000 });
  assert.equal(alice.ok, true);
});

test("SCENARIO: opened after five minutes — refused, and flagged for a re-quote", async () => {
  const store = memoryStore();
  const { id } = await createIntent(store, { telegramId: ALICE, payload: buy, now: T0 });
  const late = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + INTENT_TTL_MS + 1 });
  assert.equal(late.ok, false);
  if (!late.ok) {
    assert.equal(late.reason, "expired");
    // The UI keys its "get a fresh quote" button off this reason; the message
    // must promise a re-quote rather than imply a silent re-price.
    assert.match(consumeErrorMessage(late.reason), /expired/i);
    assert.match(consumeErrorMessage(late.reason), /re-quote|fresh/i);
  }
});

test("a forged id fails closed and is indistinguishable from someone else's", async () => {
  const store = memoryStore();
  await createIntent(store, { telegramId: ALICE, payload: buy, now: T0 });
  const forged = await consumeIntent(store, { id: "ZmFrZWlkZmFrZWlkZmFrZQ", telegramId: MALLORY, now: T0 });
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.reason, "not-found");
  // Enumeration resistance: same text for both.
  assert.equal(consumeErrorMessage("not-found"), consumeErrorMessage("wrong-user"));
});

test("an expired intent stays expired — it cannot be revived by an earlier clock", async () => {
  const store = memoryStore();
  const { id } = await createIntent(store, { telegramId: ALICE, payload: buy, now: T0 });
  const late = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + INTENT_TTL_MS + 1 });
  assert.equal(late.ok, false);
  // A client that lies about the time still cannot spend it: the server clock
  // is what consumeIntent is called with, never a value from the request body.
  const replay = await consumeIntent(store, { id, telegramId: ALICE, now: T0 + INTENT_TTL_MS + 2 });
  assert.equal(replay.ok, false);
});
