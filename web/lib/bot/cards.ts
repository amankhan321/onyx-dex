/**
 * Confirmation cards and dispatch policy for chat trading.
 *
 * Pure: no Telegram calls, no chain reads, no database. It decides what a
 * parsed command should produce and renders the text, so every rule below is
 * testable without a network. handlers.ts does the I/O.
 *
 * The rules this file enforces, all of which have tests:
 *   - A signing command NEVER executes here. It produces a card plus an intent
 *     id for the device to sign. The server has no key and builds no
 *     transaction (web/lib/bot/intents.ts holds parameters only).
 *   - Every card names the pair USDC/EURC explicitly, even though it is the
 *     only market, and spells both sides in words.
 *   - The amount is always the token the user gives away: USDC on buy, EURC on
 *     sell, and TWAP follows the same convention as the market commands.
 *   - "You receive" is the Quoter's expectedOut verbatim. Both fees are already
 *     deducted inside it (StableSwap.sol:147, Quoter.sol:131), so any fee shown
 *     is display-only and labelled as already included.
 *   - A stale oracle refuses /buy, /sell and /twap and points at /limit, never
 *     at /twap; /limit, /cancel, /withdraw and every read stay alive.
 */

import type { SignCommand, TradePayload } from "./commands";
import {
  BOOK_UNAFFECTED,
  PAIR,
  STALE_ROUTE_CHAT,
  describeSwap,
  formatRouteSplit,
  formatUnits6,
  formatRateLine,
  staleSwapMessage,
  type SwapQuote,
} from "./quote";

/** Amounts are 6dp on both tokens. */
export function toBaseUnits(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const padded = (frac + "000000").slice(0, 6);
  return BigInt(whole || "0") * 1_000_000n + BigInt(padded || "0");
}

/** Which token the user hands over — what `amount` is denominated in. */
export function givenToken(p: TradePayload): "USDC" | "EURC" | null {
  switch (p.command) {
    case "buy":
      return "USDC";
    case "sell":
      return "EURC";
    case "twap":
      // Same rule as the market commands: buy spends USDC, sell sells EURC.
      return p.zeroForOne ? "USDC" : "EURC";
    case "limit":
      // Book size is quoted in USDC on both sides; the price is EURC per USDC.
      return "USDC";
    case "withdraw":
      return "USDC";
    case "cancel":
      return null;
  }
}

/** Does this signing command need a fresh quote before the card can be shown? */
export function needsQuote(p: TradePayload): boolean {
  return p.command === "buy" || p.command === "sell";
}

export const SHORTCUT_SIZES = [10, 50, 100] as const;

/**
 * Human summary of a signing action, used as the card's headline. Names the
 * pair and spells both sides; for market swaps the receive figure comes from
 * the quote verbatim.
 */
export function describeAction(p: TradePayload, quote?: SwapQuote): string {
  switch (p.command) {
    case "buy":
    case "sell": {
      if (!quote) {
        const give = givenToken(p);
        const get = give === "USDC" ? "EURC" : "USDC";
        const verb = p.command === "buy" ? "Spend" : "Sell";
        return `${verb} ${p.amount} ${give} for ${get}`;
      }
      return describeSwap(quote.zeroForOne, quote.amountIn, quote.expectedOut);
    }
    case "limit": {
      const verb = p.isBid ? "Buy" : "Sell";
      const give = p.isBid ? "EURC" : "USDC";
      const get = p.isBid ? "USDC" : "EURC";
      return `${verb} ${p.size} USDC at ${p.price} EURC per USDC — you pay ${give}, you receive ${get} when it fills`;
    }
    case "twap": {
      const give = givenToken(p);
      const get = give === "USDC" ? "EURC" : "USDC";
      const verb = p.zeroForOne ? "Spend" : "Sell";
      const mins = Math.round(p.durationSeconds / 60);
      const every = Math.round(p.durationSeconds / p.slices / 60);
      return `${verb} ${p.total} ${give} for ${get} over ${mins}m — ${p.slices} slices, about one every ${every}m`;
    }
    case "cancel":
      return `Cancel order ${p.id}`;
    case "withdraw":
      return `Withdraw ${p.amount} USDC to ${p.to.slice(0, 6)}…${p.to.slice(-4)}`;
  }
}

/**
 * The full confirmation card. `defaultsUsed` is rendered so a defaulted value
 * is never silent, per the parser's contract.
 */
export function renderCard(
  p: TradePayload,
  opts: { quote?: SwapQuote; defaultsUsed?: string[] } = {},
): string {
  const lines: string[] = [PAIR, describeAction(p, opts.quote)];

  if (opts.quote) {
    const q = opts.quote;
    lines.push(formatRouteSplit(q.bookShare));
    // Display-only: the Quoter and StableSwap both deduct their fee inside the
    // number above, so this is never subtracted again.
    lines.push(`Fee ${q.blendedFeeBps.toFixed(2)}% (already in the quote)`);
    lines.push(`Max slippage ${(("slippageBps" in p ? p.slippageBps : 0) / 100).toFixed(2)}%`);
    lines.push(formatRateLine(q.oracle));
  }

  if (p.command === "twap") {
    lines.push(`${BOOK_UNAFFECTED.replace("The ", "")} — slices execute against the curve.`);
  }

  if (p.command === "withdraw") {
    lines.push("You'll be asked for your password on the device, every time.");
  }

  const defaults = opts.defaultsUsed ?? [];
  if (defaults.length > 0) lines.push(`Defaults used: ${defaults.join(", ")}`);

  lines.push("Nothing is signed until you tap below — your key never leaves your device.");
  return lines.join("\n");
}

/** Shortcut sizes offered beside a market swap, BONKbot-style. */
export function shortcutsFor(command: SignCommand): number[] {
  return command === "buy" || command === "sell" ? [...SHORTCUT_SIZES] : [];
}

/** Deep link into the Mini App carrying ONLY the opaque intent id. */
export function deepLink(botUsername: string, intentId: string): string {
  return `https://t.me/${botUsername}/app?startapp=${intentId}`;
}

/** The stale-oracle refusal for chat. Points at /limit, never /twap. */
export function staleRefusal(ageSeconds: number): string {
  return staleSwapMessage(ageSeconds);
}

/** Grouped /help, marking which commands need a tap to sign. */
export function renderHelp(): string {
  return [
    `*Onyx* — ${PAIR} on Arc`,
    "",
    "*Works right here in chat*",
    "/price · /quote 100 usdc eurc · /balance · /portfolio",
    "/orders · /activity · /address",
    "/alert 0.93 · /alerts · /alert off <id>",
    "/settings slippage 0.5",
    "",
    "*Needs a tap to sign on your device*",
    "/buy 100 — spend 100 USDC for EURC",
    "/sell 100 — sell 100 EURC for USDC",
    "/limit buy 100 @ 0.95 · /limit sell 100 @ 0.99",
    "/twap sell 500 over 2h",
    "/cancel <id> · /withdraw <amount> <address>",
    "",
    "These build a request and open the app to sign it. Your key, password and " +
      "recovery phrase never leave your device and never reach our servers.",
    "",
    "_Testnet only. Not audited._",
  ].join("\n");
}

/** Two-line /start explainer, per the brief. */
export const START_MODES =
  "Reads like /price and /quote answer right here in chat.\n" +
  "Trades like /buy and /limit build a request and open the app, where your device signs — " +
  "we never hold your key. /help for the full list.";

/** Refusal when a /cancel id matches nothing or is ambiguous. Never guesses. */
export function cancelRefusal(id: string, open: { order_id: string; side: string; size: string; price: string }[]): string {
  if (open.length === 0) {
    return `No open order with id \`${id}\`, and you have no open orders right now. Check /orders.`;
  }
  const list = open
    .slice(0, 10)
    .map((o) => `  \`${o.order_id}\` — ${o.side} ${o.size} USDC @ ${o.price}`)
    .join("\n");
  return `No open order with id \`${id}\`. Your open orders:\n${list}\n\nCancel one with /cancel <id>.`;
}

/** Unknown command: suggest, never execute. */
export function unknownMessage(input: string, suggestion?: string): string {
  return suggestion
    ? `Unknown command \`/${input}\`. Did you mean \`/${suggestion}\`? — /help for the full list.`
    : `Unknown command \`/${input}\`. /help for the full list.`;
}

export { formatUnits6, STALE_ROUTE_CHAT };
