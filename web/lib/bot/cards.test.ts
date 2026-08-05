import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCard,
  describeAction,
  givenToken,
  needsQuote,
  deepLink,
  renderHelp,
  cancelRefusal,
  unknownMessage,
  staleRefusal,
  toBaseUnits,
  START_MODES,
} from "./cards";
import { parseCommand, type TradePayload } from "./commands";
import { newIntentId } from "./intents";
import { PAIR, formatUnits6, type SwapQuote } from "./quote";

const OUT = 88_234_500n; // 88.2345 — verbatim from the Quoter, fees already inside

const quote: SwapQuote = {
  zeroForOne: false,
  amountIn: 100_000_000n,
  expectedOut: OUT,
  bookIn: 60_000_000n,
  ammIn: 40_000_000n,
  bookShare: 0.6,
  improvementBps: 26,
  blendedFeeBps: 2.8,
  oracle: {
    rateWad: 1_085_000_000_000_000_000n,
    updatedAt: 1000,
    ageSeconds: 120,
    stale: false,
    stalenessWindow: 21_600,
  },
};

const sell: TradePayload = { command: "sell", zeroForOne: false, tokenIn: "EURC", amount: "100", slippageBps: 50 };
const buy: TradePayload = { command: "buy", zeroForOne: true, tokenIn: "USDC", amount: "100", slippageBps: 50 };

test("toBaseUnits handles whole, fractional and short-fraction amounts", () => {
  assert.equal(toBaseUnits("100"), 100_000_000n);
  assert.equal(toBaseUnits("0.5"), 500_000n);
  assert.equal(toBaseUnits("1.234567"), 1_234_567n);
  assert.equal(toBaseUnits("1.5"), 1_500_000n);
});

test("REQUIRED: every card names the pair USDC/EURC explicitly", () => {
  const cards = [
    renderCard(buy, { quote }),
    renderCard(sell, { quote }),
    renderCard({ command: "limit", isBid: true, size: "100", price: "0.95" }),
    renderCard({ command: "twap", zeroForOne: false, total: "500", durationSeconds: 7200, slices: 6 }),
    renderCard({ command: "cancel", id: "42" }),
    renderCard({ command: "withdraw", amount: "10", to: "0x1111111111111111111111111111111111111111" }),
  ];
  for (const c of cards) assert.ok(c.includes(PAIR), `card must name ${PAIR}`);
});

test("REQUIRED: the amount is the token given away, and both sides are spelled out", () => {
  // /buy 100 = spend 100 USDC for EURC
  assert.equal(givenToken(buy), "USDC");
  assert.match(describeAction(buy), /Spend 100 USDC for EURC/);

  // /sell 100 = sell 100 EURC for USDC
  assert.equal(givenToken(sell), "EURC");
  assert.match(describeAction(sell), /Sell 100 EURC for USDC/);

  // With a quote, both sides still appear in words.
  assert.match(describeAction(sell, quote), /Sell .*EURC → receive .*USDC/);
});

test("REQUIRED: TWAP uses the same convention — 'sell' never trades the opposite way", () => {
  const twapSell: TradePayload = { command: "twap", zeroForOne: false, total: "500", durationSeconds: 7200, slices: 6 };
  const twapBuy: TradePayload = { command: "twap", zeroForOne: true, total: "500", durationSeconds: 7200, slices: 6 };

  assert.equal(givenToken(twapSell), givenToken(sell), "twap sell gives away the same token as /sell");
  assert.equal(givenToken(twapBuy), givenToken(buy), "twap buy gives away the same token as /buy");
  assert.match(describeAction(twapSell), /Sell 500 EURC for USDC/);
  assert.match(describeAction(twapBuy), /Spend 500 USDC for EURC/);
});

test("REQUIRED: the parser and the card agree on direction end to end", () => {
  // Guards against the card layer re-deriving direction and drifting from the
  // parser, which is how "sell" could come to mean two things again.
  for (const [cmd, expected] of [
    ["/sell 100", "EURC"],
    ["/buy 100", "USDC"],
    ["/twap sell 500 over 2h", "EURC"],
    ["/twap buy 500 over 2h", "USDC"],
  ] as const) {
    const r = parseCommand(cmd);
    assert.equal(r.kind, "sign");
    if (r.kind === "sign") assert.equal(givenToken(r.payload), expected, `${cmd} gives away ${expected}`);
  }
});

test("LOCK: the receive figure is the Quoter output verbatim, with no fee arithmetic", () => {
  const card = renderCard(sell, { quote });
  assert.ok(card.includes(formatUnits6(OUT)), "card shows the raw expectedOut");
  assert.match(card, /already in the quote/i, "fee is labelled as included, not deducted");
  // A re-subtracted fee would produce a smaller number; assert it is absent.
  const reduced = formatUnits6((OUT * 9_972n) / 10_000n); // if 2.8bps were removed again
  assert.ok(!card.includes(reduced), "must not show a fee-adjusted receive amount");
});

test("the TWAP card always states slice count and interval", () => {
  const card = renderCard(
    { command: "twap", zeroForOne: false, total: "500", durationSeconds: 7200, slices: 6 },
    { defaultsUsed: ["6 slices (~1 every 20m)"] },
  );
  assert.match(card, /6 slices/);
  assert.match(card, /every 20m/);
  assert.match(card, /Defaults used/, "a defaulted slice count is never silent");
});

test("REQUIRED: the withdraw card states the password prompt is unconditional", () => {
  const card = renderCard({ command: "withdraw", amount: "10", to: "0x1111111111111111111111111111111111111111" });
  assert.match(card, /password/i);
  assert.match(card, /every time/i);
});

test("REQUIRED: no card contains a transaction, calldata or key material", () => {
  const cards = [
    renderCard(buy, { quote }),
    renderCard({ command: "withdraw", amount: "10", to: "0x1111111111111111111111111111111111111111" }),
  ];
  for (const c of cards) {
    assert.doesNotMatch(c, /0x[0-9a-fA-F]{64,}/, "no signed blob or calldata");
    assert.doesNotMatch(c, /privateKey|mnemonic|seed phrase/i);
  }
});

test("every card says the key never leaves the device", () => {
  assert.match(renderCard(buy, { quote }), /never leaves your device/i);
});

test("only market swaps need a quote before the card", () => {
  assert.equal(needsQuote(buy), true);
  assert.equal(needsQuote(sell), true);
  assert.equal(needsQuote({ command: "limit", isBid: true, size: "1", price: "1" }), false);
  assert.equal(needsQuote({ command: "cancel", id: "1" }), false);
});

test("the deep link carries only the opaque id — no amounts, no addresses", () => {
  const link = deepLink("OnyxArcBot", "AbC123_-xyz", "app");
  assert.equal(link, "https://t.me/OnyxArcBot/app?startapp=AbC123_-xyz");
  assert.doesNotMatch(link, /100|0x|amount|usdc/i);
});

test("both BotFather link forms are supported, since each needs a different setup", () => {
  // Named app: requires a Mini App registered under that exact short name.
  assert.equal(
    deepLink("OnyxArcBot", "abc", "app"),
    "https://t.me/OnyxArcBot/app?startapp=abc",
  );
  // Main Mini App: no short name, so nothing to misspell. Empty selects it.
  assert.equal(deepLink("OnyxArcBot", "abc", ""), "https://t.me/OnyxArcBot?startapp=abc");
});

test("intent ids satisfy Telegram's startapp charset and length limit", () => {
  // Telegram allows only A-Z a-z 0-9 _ - in startapp, up to 512 chars. A link
  // built from an id outside that set would silently fail to deliver a
  // start_param, so the id generator and this link must agree.
  for (let i = 0; i < 20; i++) {
    const id = newIntentId();
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    assert.ok(id.length <= 512);
  }
});

test("REQUIRED: the stale refusal names /limit and never offers /twap", () => {
  const msg = staleRefusal(25_000);
  assert.match(msg, /\/limit/);
  assert.doesNotMatch(msg, /\/twap/);
});

test("/cancel refuses by name and lists open orders, never guessing", () => {
  const withOrders = cancelRefusal("99", [
    { order_id: "12", side: "buy", size: "100", price: "0.95" },
    { order_id: "13", side: "sell", size: "50", price: "0.99" },
  ]);
  assert.match(withOrders, /No open order with id/);
  assert.match(withOrders, /`12`/);
  assert.match(withOrders, /`13`/);

  const none = cancelRefusal("99", []);
  assert.match(none, /no open orders/i);
});

test("help groups the two modes and marks which need a tap", () => {
  const h = renderHelp();
  assert.ok(h.includes(PAIR));
  assert.match(h, /Works right here in chat/);
  assert.match(h, /Needs a tap to sign/);
  assert.match(h, /\/buy 100 — spend 100 USDC for EURC/);
  assert.match(h, /\/sell 100 — sell 100 EURC for USDC/);
});

test("/start explains both modes in two lines", () => {
  assert.ok(START_MODES.split("\n").length === 2);
  assert.match(START_MODES, /chat/);
  assert.match(START_MODES, /device signs/);
});

test("unknown command suggests but never executes", () => {
  assert.match(unknownMessage("byu", "buy"), /Did you mean `\/buy`/);
  assert.match(unknownMessage("xyzzy"), /Unknown command/);
  assert.doesNotMatch(unknownMessage("byu", "buy"), /signed|submitted|executed/i);
});
