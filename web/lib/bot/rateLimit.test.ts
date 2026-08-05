import { test } from "node:test";
import assert from "node:assert/strict";
import { allow, consumeToken, refill, shouldWarn, _reset, CAPACITY, REFILL_PER_SECOND } from "./rateLimit";

const T0 = 1_000_000_000_000;

test("a fresh user starts with a full bucket", () => {
  const { bucket, allowed } = consumeToken(undefined, T0);
  assert.equal(allowed, true);
  assert.equal(bucket.tokens, CAPACITY - 1);
});

test("a burst is capped at CAPACITY, then refused", () => {
  let bucket = undefined as Parameters<typeof consumeToken>[0];
  let allowedCount = 0;
  for (let i = 0; i < CAPACITY + 5; i++) {
    const r = consumeToken(bucket, T0); // same instant: no refill
    bucket = r.bucket;
    if (r.allowed) allowedCount++;
  }
  assert.equal(allowedCount, CAPACITY, "exactly CAPACITY requests pass in an instant burst");
});

test("tokens refill over time at the configured rate", () => {
  let bucket = { tokens: 0, last: T0 };
  // 3 seconds at 1/3 per second = 1 token.
  bucket = refill(bucket, T0 + 3000);
  assert.ok(Math.abs(bucket.tokens - 1) < 1e-9);
  const r = consumeToken(bucket, T0 + 3000);
  assert.equal(r.allowed, true);
});

test("refill never exceeds capacity, however long the idle stretch", () => {
  const bucket = refill({ tokens: 0, last: T0 }, T0 + 86_400_000);
  assert.equal(bucket.tokens, CAPACITY);
});

test("INVARIANT: a sustained flood cannot exceed the refill rate", () => {
  // 60 seconds of hammering every 100ms: at most CAPACITY + 60*rate get through.
  let bucket = undefined as Parameters<typeof consumeToken>[0];
  let allowed = 0;
  for (let t = 0; t <= 60_000; t += 100) {
    const r = consumeToken(bucket, T0 + t);
    bucket = r.bucket;
    if (r.allowed) allowed++;
  }
  const theoreticalMax = CAPACITY + 60 * REFILL_PER_SECOND;
  assert.ok(allowed <= Math.ceil(theoreticalMax), `${allowed} allowed exceeds cap ${theoreticalMax}`);
  assert.ok(allowed < 40, "a 600-message flood must not become 600 RPC reads");
});

test("users are throttled independently — one flood does not starve another", () => {
  _reset();
  const noisy = 111;
  const quiet = 222;
  for (let i = 0; i < CAPACITY + 10; i++) allow(noisy, T0);
  assert.equal(allow(noisy, T0), false, "the noisy user is throttled");
  assert.equal(allow(quiet, T0), true, "a different user is unaffected");
});

test("the throttle warning fires at most once per stretch", () => {
  _reset();
  const id = 333;
  assert.equal(shouldWarn(id, T0), true, "first contact may warn");
  allow(id, T0);
  assert.equal(shouldWarn(id, T0 + 1000), false, "not again a second later");
  assert.equal(shouldWarn(id, T0 + 31_000), true, "again after a quiet stretch");
});
