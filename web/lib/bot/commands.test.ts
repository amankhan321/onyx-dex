import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCommand,
  producesDeepLink,
  isServerSide,
  closestCommand,
  READ_COMMANDS,
  SIGN_COMMANDS,
  defaultTwapSlices,
  type Settings,
} from "./commands.ts";

const S: Settings = { slippageBps: 50 };

test("plain text is not a command", () => {
  assert.equal(parseCommand("hello there").kind, "not-command");
  assert.equal(parseCommand("").kind, "not-command");
});

test("INVARIANT: no signature-free command ever produces a deep link", () => {
  // Every Mode-1 command, with plausible args, must parse to a `read` — never
  // `sign` — so it can never yield a deep link.
  const reads: string[] = [
    "/help",
    "/price",
    "/quote 100 usdc eurc",
    "/balance",
    "/portfolio",
    "/orders",
    "/activity",
    "/alert 0.93",
    "/alert off 7",
    "/alerts",
    "/settings",
    "/settings slippage 0.5",
    "/address",
  ];
  for (const cmd of reads) {
    const r = parseCommand(cmd, S);
    assert.equal(r.kind, "read", `${cmd} should be a read`);
    assert.equal(producesDeepLink(r), false, `${cmd} must not produce a deep link`);
    assert.equal(isServerSide(r), true, `${cmd} runs server-side`);
  }
});

test("INVARIANT: every signing command is a `sign` result carrying only params (no tx, no execution)", () => {
  const signs: string[] = [
    "/buy 100",
    "/sell 100",
    "/limit buy 100 @ 0.95",
    "/limit sell 100 @ 0.99",
    "/twap sell 500 over 2h",
    "/cancel 42",
    "/withdraw 10 0x1111111111111111111111111111111111111111",
  ];
  for (const cmd of signs) {
    const r = parseCommand(cmd, S);
    assert.equal(r.kind, "sign", `${cmd} should be a sign`);
    assert.equal(producesDeepLink(r), true, `${cmd} produces a deep link`);
    assert.equal(isServerSide(r), false, `${cmd} must NOT run server-side`);
    if (r.kind === "sign") {
      // The payload must not contain anything executable/broadcastable.
      const json = JSON.stringify(r.payload);
      assert.ok(!/\bto\b.*data|rawTransaction|signature|0x[0-9a-fA-F]{200,}/.test(json));
    }
  }
});

test("the two command sets are disjoint and exhaustive of routing", () => {
  const overlap = READ_COMMANDS.filter((c) => (SIGN_COMMANDS as readonly string[]).includes(c));
  assert.deepEqual(overlap, []);
});

test("/buy defaults slippage from settings and says so", () => {
  const r = parseCommand("/buy 100", { slippageBps: 80 });
  assert.equal(r.kind, "sign");
  if (r.kind === "sign" && r.payload.command === "buy") {
    assert.equal(r.payload.amount, "100");
    assert.equal(r.payload.zeroForOne, true);
    assert.equal(r.payload.tokenIn, "USDC");
    assert.equal(r.payload.slippageBps, 80);
  }
  assert.ok(r.kind === "sign" && r.defaultsUsed.some((d) => d.includes("slippage")));
});

test("/sell is EURC -> USDC (per the brief), not USDC -> EURC", () => {
  const r = parseCommand("/sell 100", S);
  assert.equal(r.kind, "sign");
  if (r.kind === "sign" && r.payload.command === "sell") {
    assert.equal(r.payload.zeroForOne, false);
    assert.equal(r.payload.tokenIn, "EURC");
  }
});

test("/limit parses side, size and price, with or without @", () => {
  const a = parseCommand("/limit buy 100 @ 0.95", S);
  const b = parseCommand("/limit sell 100 0.99", S);
  assert.equal(a.kind, "sign");
  assert.equal(b.kind, "sign");
  if (a.kind === "sign" && a.payload.command === "limit") {
    assert.equal(a.payload.isBid, true);
    assert.equal(a.payload.size, "100");
    assert.equal(a.payload.price, "0.95");
  }
  if (b.kind === "sign" && b.payload.command === "limit") {
    assert.equal(b.payload.isBid, false);
    assert.equal(b.payload.price, "0.99");
  }
});

test("/twap defaults slice count from duration and reports it", () => {
  const r = parseCommand("/twap sell 500 over 2h", S);
  assert.equal(r.kind, "sign");
  if (r.kind === "sign" && r.payload.command === "twap") {
    assert.equal(r.payload.total, "500");
    assert.equal(r.payload.durationSeconds, 7200);
    assert.equal(r.payload.slices, defaultTwapSlices(7200)); // 6 at ~20m/slice
    assert.equal(r.payload.zeroForOne, true);
  }
  assert.ok(r.kind === "sign" && r.defaultsUsed.some((d) => d.includes("slices")));
});

test("/twap accepts an explicit slice count and does not report a default", () => {
  const r = parseCommand("/twap sell 500 over 2h in 4", S);
  assert.equal(r.kind, "sign");
  if (r.kind === "sign" && r.payload.command === "twap") assert.equal(r.payload.slices, 4);
  assert.ok(r.kind === "sign" && !r.defaultsUsed.some((d) => d.includes("slices")));
});

test("/cancel takes a numeric id, optionally typed", () => {
  const a = parseCommand("/cancel 42", S);
  const b = parseCommand("/cancel twap 7", S);
  assert.equal(a.kind, "sign");
  if (a.kind === "sign" && a.payload.command === "cancel") {
    assert.equal(a.payload.id, "42");
    assert.equal(a.payload.target, undefined);
  }
  if (b.kind === "sign" && b.payload.command === "cancel") assert.equal(b.payload.target, "twap");
});

test("/withdraw validates the address shape", () => {
  const good = parseCommand("/withdraw 10 0x1111111111111111111111111111111111111111", S);
  const bad = parseCommand("/withdraw 10 0xnope", S);
  assert.equal(good.kind, "sign");
  assert.equal(bad.kind, "error");
});

test("ambiguity is rejected with a one-line correction, never guessed", () => {
  for (const cmd of ["/buy", "/buy abc", "/limit buy 100", "/limit sideways 1 @ 2", "/quote", "/twap sell 500", "/settings slippage 9"]) {
    const r = parseCommand(cmd, S);
    assert.equal(r.kind, "error", `${cmd} should error`);
    if (r.kind === "error") assert.ok(r.message.length > 0 && r.message.length < 200);
  }
});

test("unknown command suggests the closest real one, and doesn't for gibberish", () => {
  const near = parseCommand("/byu 100", S);
  assert.equal(near.kind, "unknown");
  if (near.kind === "unknown") assert.equal(near.suggestion, "buy");

  const far = parseCommand("/xyzzy", S);
  assert.equal(far.kind, "unknown");
  if (far.kind === "unknown") assert.equal(far.suggestion, undefined);
});

test("closestCommand is conservative", () => {
  assert.equal(closestCommand("balence"), "balance");
  assert.equal(closestCommand("prce"), "price");
  assert.equal(closestCommand("qqqqqqqq"), undefined);
});

test("group-chat @mention suffix is stripped", () => {
  const r = parseCommand("/price@OnyxArcBot", S);
  assert.equal(r.kind, "read");
});

test("quote rejects same-token and unknown tokens", () => {
  assert.equal(parseCommand("/quote 5 usdc usdc", S).kind, "error");
  assert.equal(parseCommand("/quote 5 doge eurc", S).kind, "error");
});
