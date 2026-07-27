/**
 * Bot bootstrap.
 *
 * The server's job is menus, quotes and notifications. It builds unsigned
 * transactions and hands them to the Mini App; it never holds a key and never
 * signs. If this process were fully compromised, an attacker could show a user a
 * misleading preview — which is why the Mini App displays the transaction it is
 * actually about to sign — but could not move funds.
 */
import { Telegraf } from "telegraf";
import { createPublicClient, defineChain, http } from "viem";
import { config } from "../config";
import { initDb } from "../db";
import { registerStart } from "./handlers/start";
import { registerTrade } from "./handlers/trade";
import { registerPortfolio } from "./handlers/portfolio";
import { registerTransfer } from "./handlers/transfer";
import { registerSettings } from "./handlers/settings";
import { registerLimit } from "./handlers/limit";
import { registerTwap } from "./handlers/twap";
import { registerAlerts } from "./handlers/alerts";
import { startFillWatcher } from "../services/notifications";
import type { Ctx } from "../contracts/onyx";

const arc = defineChain({
  id: config.arc.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [config.arc.rpcUrl] } },
  blockExplorers: { default: { name: "Arcscan", url: config.arc.explorer } },
  testnet: true,
});

// batch:false — Arc's RPC intermittently drops batched eth_calls.
const client = createPublicClient({
  chain: arc,
  transport: http(config.arc.rpcUrl, { batch: false, retryCount: 2, timeout: 12_000 }),
});

const tradingCtx: Ctx = {
  client,
  chainId: config.arc.chainId,
  decimals: config.tokens.decimals,
  addresses: {
    router: config.onyx.router,
    orderBook: config.onyx.orderBook,
    quoter: config.onyx.quoter,
    stableSwap: config.onyx.stableSwap,
    twap: config.onyx.twap,
    usdc: config.tokens.usdc,
    eurc: config.tokens.eurc,
  },
};

const transferCtx = {
  client,
  chainId: config.arc.chainId,
  decimals: config.tokens.decimals,
  tokens: { usdc: config.tokens.usdc, eurc: config.tokens.eurc },
};

/** Per-user token bucket. Cheap, in-memory, enough to stop obvious abuse. */
const buckets = new Map<number, { tokens: number; ts: number }>();
function allowed(id: number): boolean {
  const now = Date.now();
  const limit = config.limits.rateLimitPerMin;
  const b = buckets.get(id) ?? { tokens: limit, ts: now };
  const refill = ((now - b.ts) / 60_000) * limit;
  b.tokens = Math.min(limit, b.tokens + refill);
  b.ts = now;
  if (b.tokens < 1) {
    buckets.set(id, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(id, b);
  return true;
}

export function createBot() {
  if (!config.telegram.token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (!config.telegram.miniAppUrl) throw new Error("MINIAPP_URL is not set");

  initDb(config.storage.databaseUrl);
  const bot = new Telegraf(config.telegram.token);

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (id && !allowed(id)) {
      if (ctx.callbackQuery) await ctx.answerCbQuery("Slow down a moment.");
      return;
    }
    return next();
  });

  registerStart(bot);
  registerTrade(bot, () => tradingCtx);
  registerPortfolio(bot, () => tradingCtx);
  registerTransfer(bot, () => transferCtx);
  registerLimit(bot, () => tradingCtx);
  registerTwap(bot, () => tradingCtx);
  registerAlerts(bot);
  registerSettings(bot);

  // Never leak an internal error to a user, and never log one that might carry
  // transaction detail we don't need.
  bot.catch((err, ctx) => {
    console.error("[bot] handler error:", err instanceof Error ? err.message : "unknown");
    void ctx.reply("Something went wrong. Please try again.");
  });

  startFillWatcher({
    bot,
    client,
    orderBook: config.onyx.orderBook,
    stableSwap: config.onyx.stableSwap,
    decimals: config.tokens.decimals,
    explorer: config.arc.explorer,
  });

  return bot;
}

if (require.main === module) {
  const bot = createBot();
  void bot.launch();
  console.log("[bot] running");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}
