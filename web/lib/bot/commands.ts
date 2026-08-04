/**
 * Command parsing — the ONE source of truth for what a chat command means.
 *
 * This module is deliberately pure: no chain reads, no signing, no Telegram
 * calls, no process.env. It turns a raw message string into a typed, validated
 * description of intent. Two invariants matter and are tested:
 *
 *   1. A Mode-1 (signature-free) command NEVER yields a `sign` result, so it can
 *      never produce a deep link. `producesDeepLink()` is true only for `sign`.
 *   2. A Mode-2 (signing) command NEVER carries a ready-to-broadcast anything —
 *      only the *parameters* of the trade. The transaction is built and signed
 *      on the user's device, from an intent, after a fresh re-quote. Nothing
 *      here executes.
 *
 * The Mini App and the bot both quote from the same on-chain quoter and build
 * writes from the same web/lib/onyxActions.ts, so the confirmation preview and
 * the signed transaction cannot drift. This file only decides *what* the user
 * asked for; it does not price or build it.
 */

export const READ_COMMANDS = [
  "help",
  "price",
  "quote",
  "balance",
  "portfolio",
  "orders",
  "activity",
  "alert",
  "alerts",
  "settings",
  "address",
] as const;

export const SIGN_COMMANDS = [
  "buy",
  "sell",
  "limit",
  "twap",
  "cancel",
  "withdraw",
] as const;

export type ReadCommand = (typeof READ_COMMANDS)[number];
export type SignCommand = (typeof SIGN_COMMANDS)[number];

/** The only live market. Pair is fixed; there is nothing to disambiguate. */
export const BASE = "USDC" as const;
export const QUOTE = "EURC" as const;
export type Token = typeof BASE | typeof QUOTE;

/** Per-user preferences the parser needs to fill defaults. Server-side stored. */
export type Settings = {
  /** Max slippage in bps. */
  slippageBps: number;
};

export const DEFAULT_SETTINGS: Settings = { slippageBps: 50 };

/**
 * Parameters of a signing action — enough to store as an intent and re-derive
 * on the device. NEVER a built transaction, address of the user, or key material.
 */
export type TradePayload =
  | {
      command: "buy" | "sell";
      /** Selling token0 (USDC) for token1 (EURC). buy = true, sell = false. */
      zeroForOne: boolean;
      /** Input token — what `amount` is denominated in. */
      tokenIn: Token;
      /** Decimal string exactly as the user wrote it; parsed to base units later. */
      amount: string;
      slippageBps: number;
    }
  | {
      command: "limit";
      isBid: boolean;
      /** Size in USDC (the book's base). */
      size: string;
      /** Price in EURC per USDC. */
      price: string;
    }
  | {
      command: "twap";
      /**
       * Market/router convention (see `zeroForOneForBuy`): true = sell USDC for
       * EURC. TWAP follows the market commands exactly — `/twap sell` sells EURC
       * (false), `/twap buy` spends USDC (true) — so "sell" never means opposite
       * things across commands. The deployed executor's own zeroForOne flag must
       * be verified on-chain and translated at the intent-constructor boundary if
       * it differs; the mapping test locks parser agreement in the meantime.
       */
      zeroForOne: boolean;
      /** Total amount, denominated in the token being given away (EURC on sell, USDC on buy). */
      total: string;
      durationSeconds: number;
      slices: number;
    }
  | {
      command: "cancel";
      id: string;
      /** Which book of ids to cancel from, if the user said. Resolved server-side otherwise. */
      target?: "order" | "twap";
    }
  | {
      command: "withdraw";
      amount: string;
      to: string;
    };

export type ReadPayload =
  | { command: "help" | "balance" | "portfolio" | "orders" | "activity" | "alerts" | "address" }
  | { command: "price" }
  | { command: "quote"; amount: string; tokenIn: Token; tokenOut: Token; zeroForOne: boolean }
  | { command: "alert"; op: "set"; direction: "above" | "below"; price: string }
  | { command: "alert"; op: "list" }
  | { command: "alert"; op: "off"; id: string }
  | { command: "settings"; op: "show" }
  | { command: "settings"; op: "set-slippage"; slippageBps: number };

export type ParseResult =
  | { kind: "read"; payload: ReadPayload; defaultsUsed: string[] }
  | { kind: "sign"; payload: TradePayload; defaultsUsed: string[] }
  /** Ambiguous or invalid: a one-line correction to show the user, never a guess. */
  | { kind: "error"; message: string }
  /** Unknown command: suggest the closest real one, never execute. */
  | { kind: "unknown"; input: string; suggestion?: string }
  /** Not a slash command at all — plain text. */
  | { kind: "not-command" };

/** True only for signing results. The webhook uses this as the deep-link gate. */
export function producesDeepLink(r: ParseResult): boolean {
  return r.kind === "sign";
}

/** True for commands the server answers directly (reads + server-side alert/settings writes). */
export function isServerSide(r: ParseResult): boolean {
  return r.kind === "read";
}

/**
 * The ONE market-direction rule, shared by /buy, /sell and /twap so the word
 * "sell" can never mean opposite things across commands.
 *
 * The pair is EURC/USDC: USDC is the quote currency, EURC is the asset.
 *   buy  = spend USDC, receive EURC = sell token0 (USDC) → zeroForOne true
 *   sell = sell EURC,  receive USDC = sell token1 (EURC) → zeroForOne false
 *
 * `zeroForOne` here is the router/pool convention used everywhere in the app
 * (SwapTab, useSwapQuote, onyxActions). The amount a user names is always the
 * token they give away: USDC on buy, EURC on sell.
 */
export const zeroForOneForBuy = (isBuy: boolean): boolean => isBuy;

const ALL_COMMANDS: string[] = [...READ_COMMANDS, ...SIGN_COMMANDS];

/** Levenshtein, small and allocation-light — only ever run on short command words. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Closest real command within a small edit distance, or undefined if nothing's near. */
export function closestCommand(word: string): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of ALL_COMMANDS) {
    const d = editDistance(word, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  // Only suggest a genuinely close match; "xyzzy" should get nothing.
  const threshold = word.length <= 4 ? 2 : 3;
  return bestD <= threshold ? best : undefined;
}

/** A positive decimal number as a string, else null. Rejects NaN, <=0, +Inf, junk. */
function parsePositiveDecimal(s: string): string | null {
  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return s;
}

/** A duration like `2h`, `90m`, `30s`, `1h30m` → seconds, else null. */
function parseDuration(s: string): number | null {
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const secs = (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
  return secs > 0 ? secs : null;
}

function tokenOf(word: string): Token | null {
  const u = word.toUpperCase();
  if (u === "USDC") return BASE;
  if (u === "EURC") return QUOTE;
  return null;
}

/** TWAP defaults when the user gives only `over <duration>`: one slice / ~20 min. */
export const TWAP_SLICE_TARGET_SECONDS = 20 * 60;
export const TWAP_MIN_SLICES = 2;
export const TWAP_MAX_SLICES = 100;

export function defaultTwapSlices(durationSeconds: number): number {
  const raw = Math.round(durationSeconds / TWAP_SLICE_TARGET_SECONDS);
  return Math.min(TWAP_MAX_SLICES, Math.max(TWAP_MIN_SLICES, raw));
}

/**
 * Parse a raw chat message into a typed result.
 *
 * `settings` supplies defaults (slippage). When a default is used it is listed
 * in `defaultsUsed` so the confirmation card can say which one — the brief
 * requires that a defaulted value is never silent.
 */
export function parseCommand(input: string, settings: Settings = DEFAULT_SETTINGS): ParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { kind: "not-command" };

  // Strip a leading slash and any @BotName suffix Telegram appends in groups.
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const command = head.split("@")[0].toLowerCase();
  const args = rest;

  const isRead = (READ_COMMANDS as readonly string[]).includes(command);
  const isSign = (SIGN_COMMANDS as readonly string[]).includes(command);
  if (!isRead && !isSign) {
    return { kind: "unknown", input: command, suggestion: closestCommand(command) };
  }

  const defaultsUsed: string[] = [];

  // ------------------------------- Mode 1 --------------------------------
  switch (command) {
    case "help":
    case "balance":
    case "portfolio":
    case "orders":
    case "activity":
    case "alerts":
    case "address":
      return { kind: "read", payload: { command }, defaultsUsed };

    case "price":
      return { kind: "read", payload: { command: "price" }, defaultsUsed };

    case "quote": {
      // /quote 100 usdc eurc   — amount + optional in/out tokens.
      if (args.length === 0) {
        return { kind: "error", message: "Usage: /quote <amount> [usdc eurc]. Example: /quote 100 usdc eurc" };
      }
      const amount = parsePositiveDecimal(args[0]);
      if (!amount) return { kind: "error", message: `\`${args[0]}\` isn't a positive amount. Try: /quote 100 usdc eurc` };

      let tokenIn: Token = BASE;
      let tokenOut: Token = QUOTE;
      if (args.length >= 2) {
        const a = tokenOf(args[1]);
        if (!a) return { kind: "error", message: `Unknown token \`${args[1]}\`. Only USDC and EURC trade here.` };
        tokenIn = a;
      } else {
        defaultsUsed.push("pair USDC→EURC");
      }
      if (args.length >= 3) {
        const b = tokenOf(args[2]);
        if (!b) return { kind: "error", message: `Unknown token \`${args[2]}\`. Only USDC and EURC trade here.` };
        tokenOut = b;
      } else if (args.length >= 2) {
        tokenOut = tokenIn === BASE ? QUOTE : BASE;
      }
      if (tokenIn === tokenOut) {
        return { kind: "error", message: "In and out token are the same — nothing to quote." };
      }
      return {
        kind: "read",
        payload: { command: "quote", amount, tokenIn, tokenOut, zeroForOne: tokenIn === BASE },
        defaultsUsed,
      };
    }

    case "alert": {
      // /alert 0.93 | /alert above 0.93 | /alert below 0.9 | /alert off <id>
      if (args.length === 0) {
        return { kind: "error", message: "Usage: /alert <price>, or /alert off <id>. Example: /alert 0.93" };
      }
      if (args[0].toLowerCase() === "off") {
        if (!args[1]) return { kind: "error", message: "Which alert? Usage: /alert off <id>" };
        return { kind: "read", payload: { command: "alert", op: "off", id: args[1] }, defaultsUsed };
      }
      let direction: "above" | "below" | null = null;
      let priceArg = args[0];
      if (args[0].toLowerCase() === "above" || args[0].toLowerCase() === "below") {
        direction = args[0].toLowerCase() as "above" | "below";
        priceArg = args[1] ?? "";
      }
      const price = parsePositiveDecimal(priceArg);
      if (!price) {
        return { kind: "error", message: `\`${priceArg || args[0]}\` isn't a valid price. Example: /alert 0.93` };
      }
      // Direction defaults are resolved server-side against the current price
      // (above if target is over spot, else below); the parser leaves it open
      // rather than guessing a direction that could be wrong.
      if (!direction) defaultsUsed.push("direction from current price");
      return {
        kind: "read",
        payload: direction
          ? { command: "alert", op: "set", direction, price }
          : { command: "alert", op: "set", direction: "above", price }, // placeholder; server re-derives if defaulted
        defaultsUsed,
      };
    }

    case "settings": {
      // /settings                → show
      // /settings slippage 0.5   → set slippage to 0.5%
      if (args.length === 0) {
        return { kind: "read", payload: { command: "settings", op: "show" }, defaultsUsed };
      }
      if (args[0].toLowerCase() === "slippage") {
        const pct = parsePositiveDecimal(args[1] ?? "");
        if (!pct) return { kind: "error", message: "Usage: /settings slippage <percent>. Example: /settings slippage 0.5" };
        const bps = Math.round(Number(pct) * 100);
        if (bps < 1 || bps > 300) {
          return { kind: "error", message: "Slippage must be between 0.01% and 3%." };
        }
        return { kind: "read", payload: { command: "settings", op: "set-slippage", slippageBps: bps }, defaultsUsed };
      }
      return { kind: "error", message: `Unknown setting \`${args[0]}\`. Try: /settings slippage 0.5` };
    }
  }

  // ------------------------------- Mode 2 --------------------------------
  switch (command) {
    case "buy":
    case "sell": {
      // /buy 100  → 100 USDC → EURC ;  /sell 100 → 100 EURC → USDC
      if (args.length === 0) {
        return { kind: "error", message: `Usage: /${command} <amount>. Example: /${command} 100` };
      }
      const amount = parsePositiveDecimal(args[0]);
      if (!amount) return { kind: "error", message: `\`${args[0]}\` isn't a positive amount. Example: /${command} 100` };
      const buy = command === "buy";
      defaultsUsed.push(`slippage ${(settings.slippageBps / 100).toFixed(2)}%`);
      return {
        kind: "sign",
        payload: {
          command,
          zeroForOne: zeroForOneForBuy(buy),
          // Amount is denominated in the token given away: USDC on buy, EURC on sell.
          tokenIn: buy ? BASE : QUOTE,
          amount,
          slippageBps: settings.slippageBps,
        },
        defaultsUsed,
      };
    }

    case "limit": {
      // /limit buy 100 @ 0.95   |   /limit sell 100 @ 0.99
      const side = (args[0] ?? "").toLowerCase();
      if (side !== "buy" && side !== "sell") {
        return { kind: "error", message: "Usage: /limit buy|sell <size> @ <price>. Example: /limit buy 100 @ 0.95" };
      }
      // Accept `100 @ 0.95` or `100 0.95`.
      const withoutAt = args.slice(1).filter((a) => a !== "@");
      const size = parsePositiveDecimal(withoutAt[0] ?? "");
      const price = parsePositiveDecimal(withoutAt[1] ?? "");
      if (!size || !price) {
        return { kind: "error", message: "Usage: /limit buy|sell <size> @ <price>. Example: /limit buy 100 @ 0.95" };
      }
      return { kind: "sign", payload: { command: "limit", isBid: side === "buy", size, price }, defaultsUsed };
    }

    case "twap": {
      // /twap sell 500 over 2h [in <n> | every <duration>]
      const side = (args[0] ?? "").toLowerCase();
      if (side !== "sell" && side !== "buy") {
        return { kind: "error", message: "Usage: /twap sell|buy <total> over <duration>. Example: /twap sell 500 over 2h" };
      }
      const total = parsePositiveDecimal(args[1] ?? "");
      if (!total) return { kind: "error", message: `\`${args[1] ?? ""}\` isn't a positive total. Example: /twap sell 500 over 2h` };
      const overIdx = args.findIndex((a) => a.toLowerCase() === "over");
      if (overIdx === -1 || !args[overIdx + 1]) {
        return { kind: "error", message: "Say how long: /twap sell 500 over 2h" };
      }
      const durationSeconds = parseDuration(args[overIdx + 1]);
      if (!durationSeconds) {
        return { kind: "error", message: `\`${args[overIdx + 1]}\` isn't a duration. Use e.g. 2h, 90m, 1h30m.` };
      }

      // Optional explicit slice count: `in 6`. Otherwise default and report it.
      let slices: number;
      const inIdx = args.findIndex((a) => a.toLowerCase() === "in");
      if (inIdx !== -1 && args[inIdx + 1]) {
        const n = Number(args[inIdx + 1]);
        if (!Number.isInteger(n) || n < TWAP_MIN_SLICES || n > TWAP_MAX_SLICES) {
          return { kind: "error", message: `Slices must be a whole number ${TWAP_MIN_SLICES}–${TWAP_MAX_SLICES}.` };
        }
        slices = n;
      } else {
        slices = defaultTwapSlices(durationSeconds);
        defaultsUsed.push(`${slices} slices (~1 every ${Math.round(durationSeconds / slices / 60)}m)`);
      }
      return {
        kind: "sign",
        // Same direction rule as /buy and /sell: sell = selling EURC (false).
        payload: { command: "twap", zeroForOne: zeroForOneForBuy(side === "buy"), total, durationSeconds, slices },
        defaultsUsed,
      };
    }

    case "cancel": {
      // /cancel <id>  |  /cancel order <id>  |  /cancel twap <id>
      let target: "order" | "twap" | undefined;
      let idArg = args[0];
      if (args[0] === "order" || args[0] === "twap") {
        target = args[0];
        idArg = args[1];
      }
      if (!idArg || !/^\d+$/.test(idArg)) {
        return { kind: "error", message: "Usage: /cancel <id>. Find ids with /orders." };
      }
      return { kind: "sign", payload: { command: "cancel", id: idArg, target }, defaultsUsed };
    }

    case "withdraw": {
      // /withdraw <amount> <addr> — always re-auth on device, never a saved addr.
      const amount = parsePositiveDecimal(args[0] ?? "");
      const to = args[1] ?? "";
      if (!amount || !to) {
        return { kind: "error", message: "Usage: /withdraw <amount> <address>." };
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
        return { kind: "error", message: "That destination isn't a valid 0x address." };
      }
      return { kind: "sign", payload: { command: "withdraw", amount, to }, defaultsUsed };
    }
  }

  // Unreachable: every SIGN/READ command is handled above. Fail closed.
  return { kind: "unknown", input: command, suggestion: closestCommand(command) };
}
