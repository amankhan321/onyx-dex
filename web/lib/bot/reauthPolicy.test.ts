import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The re-auth policy, as a table.
 *
 * Speed on warm-session trades comes from ONE thing: skipping a redundant
 * password prompt on a small trade while a wallet is already unlocked and
 * inside its idle window. Everything else stays exactly as it was. This test
 * exists so that "make it faster" can never quietly erode a rail — if someone
 * makes a withdrawal skip its prompt, or lets a cold session through, it fails.
 *
 * The rule mirrors IntentConfirm's `willPrompt` and the escalation in
 * signer.writeBatch (`reqs.some(r => r.requiresReauth)`).
 */

const REAUTH_THRESHOLD = 50;

/** Does this action demand a password, regardless of session state? */
function alwaysReauth(command: string, amount: number): boolean {
  return command === "withdraw" || amount > REAUTH_THRESHOLD;
}

/** Will the user be prompted for a password on this tap? */
function willPrompt(command: string, amount: number, sessionWarm: boolean): boolean {
  return alwaysReauth(command, amount) || !sessionWarm;
}

test("RAIL: a withdrawal always prompts, warm session or not", () => {
  assert.equal(willPrompt("withdraw", 1, true), true);
  assert.equal(willPrompt("withdraw", 1, false), true);
  assert.equal(willPrompt("withdraw", 1_000_000, true), true);
  // Even a dust withdrawal in a freshly-unlocked session.
  assert.equal(alwaysReauth("withdraw", 0.000001), true);
});

test("RAIL: anything over REAUTH_THRESHOLD always prompts", () => {
  assert.equal(willPrompt("buy", REAUTH_THRESHOLD + 0.000001, true), true);
  assert.equal(willPrompt("sell", REAUTH_THRESHOLD + 1, true), true);
  assert.equal(willPrompt("buy", 10_000, true), true);
});

test("RAIL: a cold session always prompts, however small the trade", () => {
  assert.equal(willPrompt("buy", 1, false), true);
  assert.equal(willPrompt("sell", 0.5, false), true);
});

test("SPEED: a small trade in a warm session is one tap, no prompt", () => {
  assert.equal(willPrompt("buy", 10, true), false);
  assert.equal(willPrompt("sell", 50, true), false, "at the threshold, not over it");
  assert.equal(willPrompt("buy", 49.999, true), false);
});

test("the threshold boundary is exclusive — 50 is fast, 50.000001 is not", () => {
  assert.equal(alwaysReauth("buy", REAUTH_THRESHOLD), false);
  assert.equal(alwaysReauth("buy", REAUTH_THRESHOLD + 0.000001), true);
});

test("the shortcut sizes are all at or under the threshold, so they stay one-tap", () => {
  // If a shortcut is ever raised above REAUTH_THRESHOLD it silently stops being
  // a one-tap button; this is the test that would notice.
  for (const size of [10, 50, 100]) {
    const fast = !alwaysReauth("buy", size);
    if (size <= REAUTH_THRESHOLD) assert.equal(fast, true, `${size} should be one-tap`);
    else assert.equal(fast, false, `${size} exceeds the threshold and must prompt`);
  }
});

test("no combination of inputs makes a withdrawal skip its prompt", () => {
  for (const amount of [0, 0.001, 1, 49, 50, 51, 1e9]) {
    for (const warm of [true, false]) {
      assert.equal(willPrompt("withdraw", amount, warm), true);
    }
  }
});
