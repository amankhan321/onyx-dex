/**
 * Bot handlers.
 *
 * Trading is initiated in chat and SIGNED ON THE DEVICE. This module never
 * signs, never builds a transaction, and never holds key material — there is no
 * server-side signing key and none may be added. A signing command produces a
 * single-use intent (parameters only) plus a deep link; the Mini App re-quotes,
 * re-derives every number on the device, shows what it is about to sign, and
 * signs it there.
 *
 * The split is enforced by the parser, not by hand: parseCommand() returns
 * `read` for commands the server can answer and `sign` for commands it cannot.
 * producesDeepLink() is true only for `sign`, and a `read` never reaches the
 * intent path. See lib/bot/commands.ts.
 */
import { answerCallback, editMessage, getMe, sendMessage, type InlineButton } from "./telegram";
import { intentStore, openOrdersFor, referralCount, upsertUser } from "./db";
import { parseCommand, producesDeepLink, type ParseResult, type TradePayload } from "./commands";
import { createIntent } from "./intents";
import {
  START_MODES,
  cancelRefusal,
  deepLink,
  needsQuote,
  renderCard,
  renderHelp,
  staleRefusal,
  toBaseUnits,
  unknownMessage,
} from "./cards";
import { makeReads } from "./reader";
import { allow } from "./rateLimit";
import { quoteSwap, refusalMessage, renderPrice, renderQuote, staleGate } from "./quote";

const MINIAPP_URL = process.env.MINIAPP_URL ?? "https://onyx-dex.vercel.app/miniapp";

const openButton: InlineButton[][] = [
  [{ text: "📈 Open Onyx", web_app: { url: MINIAPP_URL } }],
  [{ text: "🤝 Referral", callback_data: "referral" }, { text: "❓ Help", callback_data: "help" }],
];

const WELCOME =
  "*Onyx* — the on-chain order book on Arc.\n\n" +
  "*This is self-custody.*\n" +
  "Your wallet is created and unlocked on your own device. Your password and " +
  "private key never reach our servers — we hold only an encrypted file we cannot open.\n\n" +
  "That means *nobody can recover your funds for you.* Your recovery phrase is the " +
  "only backup, and you are shown it once.\n\n" +
  "Tap below to open the app.";

export async function handleMessage(msg: {
  chat: { id: number };
  from?: { id: number; username?: string };
  text?: string;
}) {
  const from = msg.from;
  if (!from) return;
  const text = (msg.text ?? "").trim();

  // Per-user throttle: a flood of commands must not become a flood of RPC
  // reads. Silent when exhausted — replying to every message in a burst would
  // amplify it rather than damp it.
  if (!allow(from.id)) return;

  if (text.startsWith("/start")) {
    // /start <referrerId> — credited only on first contact.
    const payload = text.split(/\s+/)[1] ?? "";
    const referrer = /^\d+$/.test(payload) && Number(payload) !== from.id ? Number(payload) : undefined;
    await upsertUser(from.id, from.username, referrer);
    await sendMessage(msg.chat.id, `${WELCOME}\n\n${START_MODES}`, openButton);
    return;
  }

  if (text.startsWith("/referral")) {
    await upsertUser(from.id, from.username);
    await sendReferral(msg.chat.id, from.id);
    return;
  }

  if (text.startsWith("/help")) {
    await sendMessage(msg.chat.id, renderHelp(), openButton);
    return;
  }

  const parsed = parseCommand(text);

  if (parsed.kind === "sign") {
    await handleSigning(msg.chat.id, from.id, parsed);
    return;
  }

  if (parsed.kind === "read") {
    await handleRead(msg.chat.id, from.id, parsed);
    return;
  }

  if (parsed.kind === "error") {
    await sendMessage(msg.chat.id, parsed.message);
    return;
  }

  if (parsed.kind === "unknown") {
    await sendMessage(msg.chat.id, unknownMessage(parsed.input, parsed.suggestion));
    return;
  }

  // Not a command at all: the existing thin fallback, unchanged.
  await sendMessage(msg.chat.id, "Everything happens in the app — tap below.", openButton);
}

/**
 * Mode 2. Parses to parameters, quotes for the card, stores a single-use
 * intent, and hands back a deep link. NOTHING is executed or signed here.
 */
async function handleSigning(chatId: number, telegramId: number, parsed: Extract<ParseResult, { kind: "sign" }>) {
  const payload = parsed.payload;

  // The parser guarantees this, but assert it at the boundary: only a `sign`
  // result may ever reach the deep-link path.
  if (!producesDeepLink(parsed)) return;

  const reads = makeReads();

  // Stale oracle: refuse the AMM-dependent commands, keep the book alive.
  // staleGate() is the shipped policy — /limit, /cancel and /withdraw pass.
  let oracleAge: number | null = null;
  try {
    const oracle = await reads.oracle();
    oracleAge = oracle.ageSeconds;
    const gate = staleGate(payload.command, oracle);
    if (gate) {
      await sendMessage(chatId, gate);
      return;
    }
  } catch {
    await sendMessage(chatId, "Couldn't read the chain just now, so I won't guess a number. Try again in a moment.");
    return;
  }

  // /cancel resolves server-side against this user's open orders. Never guesses.
  if (payload.command === "cancel") {
    const open = await openOrdersFor(telegramId);
    const matches = open.filter((o) => o.order_id === payload.id);
    if (matches.length !== 1) {
      await sendMessage(chatId, cancelRefusal(payload.id, open));
      return;
    }
  }

  // Market swaps get a fresh quote for the card. The device re-quotes before
  // signing regardless, so this is a preview, never the number that is signed.
  let quote;
  if (needsQuote(payload)) {
    const amountIn = toBaseUnits("amount" in payload ? payload.amount : "0");
    const result = await quoteSwap(reads, { zeroForOne: payload.command === "buy", amountIn });
    if (!result.ok) {
      await sendMessage(chatId, result.reason === "stale-oracle" ? staleRefusal(oracleAge ?? 0) : refusalMessage(result));
      return;
    }
    quote = result.quote;
  }

  const intent = await createIntent(intentStore, { telegramId, payload, now: Date.now() });
  const me = await getMe();

  await sendMessage(chatId, renderCard(payload, { quote, defaultsUsed: parsed.defaultsUsed }), [
    [{ text: "🔏 Sign in Onyx", url: deepLink(me.username, intent.id) }],
    ...shortcutRow(payload),
  ]);
}

/** BONKbot-style size shortcuts, re-running the command at another size. */
function shortcutRow(payload: TradePayload): InlineButton[][] {
  if (payload.command !== "buy" && payload.command !== "sell") return [];
  return [
    [10, 50, 100].map((n) => ({
      text: `${n}`,
      callback_data: `size:${payload.command}:${n}`,
    })),
  ];
}

/** Mode 1. Answered server-side; can never produce a deep link. */
async function handleRead(chatId: number, telegramId: number, parsed: Extract<ParseResult, { kind: "read" }>) {
  const p = parsed.payload;
  const reads = makeReads();

  try {
    switch (p.command) {
      case "price": {
        const [oracle, book] = await Promise.all([reads.oracle(), reads.book()]);
        await sendMessage(chatId, renderPrice(oracle, book));
        return;
      }
      case "quote": {
        const result = await quoteSwap(reads, {
          zeroForOne: p.zeroForOne,
          amountIn: toBaseUnits(p.amount),
        });
        await sendMessage(chatId, result.ok ? renderQuote(result.quote) : refusalMessage(result));
        return;
      }
      case "orders": {
        const open = await openOrdersFor(telegramId);
        await sendMessage(
          chatId,
          open.length === 0
            ? "No open orders. /limit buy 100 @ 0.95 to place one."
            : ["*Open orders* — USDC/EURC", ...open.map((o) => `\`${o.order_id}\` — ${o.side} ${o.size} USDC @ ${o.price}`)].join("\n"),
        );
        return;
      }
      default:
        // Remaining reads (balance, portfolio, activity, address, alerts,
        // settings) need per-user chain and DB reads that land in the next
        // step; they are parsed but not yet answered.
        await sendMessage(chatId, "That one's coming next — /price, /quote and /orders work now.");
        return;
    }
  } catch {
    await sendMessage(chatId, "Couldn't read the chain just now, so I won't guess a number. Try again in a moment.");
  }
}

export async function handleCallback(cb: {
  id: string;
  from: { id: number; username?: string };
  message?: { chat: { id: number }; message_id: number };
  data?: string;
}) {
  await answerCallback(cb.id);
  if (!cb.message) return;
  const { chat, message_id } = cb.message;

  if (cb.data === "referral") {
    await sendReferral(chat.id, cb.from.id);
    return;
  }
  /**
   * Size shortcuts (10 / 50 / 100) from a swap card.
   *
   * These cannot execute the trade: there is no server-side key, so the server
   * physically cannot sign. What they DO is collapse the slow part — re-typing
   * the command and waiting for a fresh quote — into one tap that yields a
   * ready-to-sign link. With a warm session the next tap signs without a
   * password, so a shortcut is two taps from card to broadcast.
   */
  if (cb.data?.startsWith("size:")) {
    const [, command, size] = cb.data.split(":");
    if ((command === "buy" || command === "sell") && /^\d+$/.test(size)) {
      const parsed = parseCommand(`/${command} ${size}`);
      if (parsed.kind === "sign") await handleSigning(chat.id, cb.from.id, parsed);
    }
    return;
  }

  if (cb.data === "help") {
    await editMessage(
      chat.id,
      message_id,
      "*Help*\n\n" +
        "Swaps, limit orders and TWAPs all happen inside the app, where your wallet " +
        "signs on this device.\n\n" +
        "You'll get a message here when a limit order fills or a price alert triggers.\n\n" +
        "_Testnet only. Not audited._",
      openButton,
    );
    return;
  }
}

async function sendReferral(chatId: number, telegramId: number) {
  const me = await getMe();
  const link = `https://t.me/${me.username}?start=${telegramId}`;
  const n = await referralCount(telegramId);
  await sendMessage(
    chatId,
    `*Your referral link*\n\n\`${link}\`\n\nReferred so far: *${n}*\n\n_Fee sharing is currently off._`,
    openButton,
  );
}
