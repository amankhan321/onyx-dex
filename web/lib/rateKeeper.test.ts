import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decide,
  HEARTBEAT_AFTER,
  ALERT_AFTER,
  MIN_UPDATE_INTERVAL,
  STALENESS_WINDOW,
} from "./rateKeeper";

/**
 * The keeper's decision logic had no test, which is how a scheduling problem
 * went unnoticed: decide() was correct, but nothing pinned the relationship
 * between its heartbeat threshold and the real cadence of the runs calling it.
 *
 * Observed spacing between scheduled runs, from the Actions history:
 * 78, 85, 103, 110, 115, 144, 146, 169 minutes.
 *
 * PROVISIONAL. A live gap has since passed 169 minutes without resolving, so
 * LONGEST_GAP understates the real worst case. These numbers are deliberately
 * NOT updated mid-gap — the true length is unknown until the next run fires.
 * When it does, update this array, the HEARTBEAT_AFTER comment in rateKeeper.ts
 * and the rate-keeper.yml header together, in one commit.
 *
 * Nothing below asserts an exact margin figure, for the same reason: only
 * relations that hold whatever the dataset turns out to be.
 */
const OBSERVED_GAPS_SECONDS = [78, 85, 103, 110, 115, 144, 146, 169].map((m) => m * 60);
const SHORTEST_GAP = Math.min(...OBSERVED_GAPS_SECONDS); // 4,680s
const LONGEST_GAP = Math.max(...OBSERVED_GAPS_SECONDS); // 10,140s

const RATE = 1_085_000_000_000_000_000n;

test("below MIN_UPDATE_INTERVAL it skips — setRate would revert TooSoon", () => {
  const d = decide({ ageSeconds: MIN_UPDATE_INTERVAL - 1, currentWad: RATE, targetWad: RATE });
  assert.equal(d.action, "skip");
  assert.match(d.reason, /TooSoon/);
});

test("no material change and a fresh rate skips", () => {
  const d = decide({ ageSeconds: HEARTBEAT_AFTER - 1, currentWad: RATE, targetWad: RATE });
  assert.equal(d.action, "skip");
});

test("no material change past HEARTBEAT_AFTER pushes the SAME value to refresh the timestamp", () => {
  const d = decide({ ageSeconds: HEARTBEAT_AFTER + 1, currentWad: RATE, targetWad: RATE });
  assert.equal(d.action, "push");
  if (d.action === "push") {
    assert.equal(d.value, RATE, "a heartbeat re-pushes the current value, it does not invent one");
    assert.match(d.reason, /heartbeat/);
  }
});

test("a real move pushes regardless of age, once past MIN_UPDATE_INTERVAL", () => {
  const moved = (RATE * 10_020n) / 10_000n; // +20 bps
  const d = decide({ ageSeconds: MIN_UPDATE_INTERVAL + 1, currentWad: RATE, targetWad: moved });
  assert.equal(d.action, "push");
});

test("INVARIANT: every run that fires refreshes the timestamp", () => {
  // This is the point of the 1h threshold. If HEARTBEAT_AFTER ever creeps back
  // above the shortest gap between runs, some runs will skip and the timestamp
  // will age while the workflow still reports success — the exact failure that
  // left the feed 1h11m overdue.
  assert.ok(
    HEARTBEAT_AFTER < SHORTEST_GAP,
    `HEARTBEAT_AFTER (${HEARTBEAT_AFTER}s) must stay below the shortest observed gap (${SHORTEST_GAP}s)`,
  );
  for (const gap of OBSERVED_GAPS_SECONDS) {
    const d = decide({ ageSeconds: gap, currentWad: RATE, targetWad: RATE });
    assert.equal(d.action, "push", `a run arriving after ${gap / 60}m must push, not skip`);
  }
});

test("INVARIANT: heartbeat + worst observed gap stays inside the staleness window", () => {
  const worstCase = HEARTBEAT_AFTER + LONGEST_GAP;
  assert.ok(
    worstCase < STALENESS_WINDOW,
    `worst case ${worstCase}s must stay under STALENESS_WINDOW ${STALENESS_WINDOW}s`,
  );

  // Margin as of the dataset above: 3,600 + 10,140 = 13,740s used, leaving
  // 7,860s (2h11m). That absorbs one further SHORT gap (78m) but not two, and
  // not another worst-case gap (169m). 1h is a large improvement on the 2h
  // threshold, which left only 4,260s — it is not immunity.
  //
  // The exact figure stays in this comment, deliberately not in an assertion:
  // asserting it would be an arithmetic identity of two constants, so it would
  // fail the moment OBSERVED_GAPS_SECONDS is updated — for the wrong reason,
  // reporting a stale dataset as a broken invariant. The relations below are
  // what actually matter and they hold across any dataset.
  const margin = STALENESS_WINDOW - worstCase;
  assert.ok(margin > 0, "a heartbeat at the worst observed gap must not already be past the halt");
  assert.ok(
    margin > SHORTEST_GAP,
    `margin ${margin}s has fallen below the shortest observed gap ${SHORTEST_GAP}s — the schedule ` +
      `has degraded far enough that HEARTBEAT_AFTER alone no longer covers it. This is a real ` +
      `breach, not a stale dataset: reduce HEARTBEAT_AFTER or move off GitHub's scheduler.`,
  );
  assert.ok(margin < LONGEST_GAP, "does NOT absorb a further worst-case gap — documented, not fixed");
});

test("the frozen constants are unchanged", () => {
  // These are fixed by the contracts and the brief; only HEARTBEAT_AFTER moved.
  assert.equal(MIN_UPDATE_INTERVAL, 300);
  assert.equal(STALENESS_WINDOW, 21_600);
  assert.equal(ALERT_AFTER, 14_400);
  assert.ok(ALERT_AFTER < STALENESS_WINDOW, "the warning must arrive before the halt");
});
