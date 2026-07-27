import type { Telegraf } from "telegraf";
import { amountKeyboard, confirmKeyboard, mainMenu, walletSetupKeyboard } from "../keyboards";
import { getSettings, getUser, recordTrade } from "../../db";
import { fmtUnits, planMarketSwap, type Ctx } from "../../contracts/onyx";
import { config } from "../../config";

/**
 * Buy / Sell.
 *
 * The confirmation screen shows the route split, the AMM-only comparison and the
 * price impact BEFORE the signing button appears — a user should never tap
 * "sign" without seeing what they're getting. The numbers come from the same
 * planMarketSwap() the Mini App will use, so the preview cannot drift from the
 * transaction that actually executes.
 */
const pending = new Map<number, { side: "buy" | "sell" }>();

export function registerTrade(bot: Telegraf, ctxOf: () => Ctx) {
  for (const side of ["buy", "sell"] as const) {
    bot.action(side, async (c) => {
      await c.answerCbQuery();
      const user = getUser(c.from.id);
      if (!user?.address) {
        await c.editMessageText("Set up your wallet first.", walletSetupKeyboard());
        return;
      }
      pending.set(c.from.id, { side });
      const { defaultAmounts } = getSettings(c.from.id);
      await c.editMessageText(
        side === "buy" ? "How much USDC to spend?" : "How much USDC to sell?",
        amountKeyboard(side, defaultAmounts),
      );
    });

    bot.action(new RegExp(`^${side}:amt:(.+)$`), async (c) => {
      await c.answerCbQuery();
      const raw = (c.match as RegExpMatchArray)[1];
      if (raw === "custom") {
        pending.set(c.from.id, { side });
        await c.editMessageText("Send the amount as a number, e.g. 25.5");
        return;
      }
      await quoteAndConfirm(c, side, raw === "max" ? "max" : Number(raw), ctxOf);
    });
  }

  // Custom amount typed as a plain message.
  bot.on("text", async (c, next) => {
    const p = pending.get(c.from.id);
    const n = Number(c.message.text.trim());
    if (!p || !Number.isFinite(n) || n <= 0) return next();
    pending.delete(c.from.id);
    await quoteAndConfirm(c, p.side, n, ctxOf);
  });
}

async function quoteAndConfirm(
  c: Parameters<Parameters<Telegraf["action"]>[1]>[0],
  side: "buy" | "sell",
  amount: number | "max",
  ctxOf: () => Ctx,
) {
  const user = getUser(c.from.id);
  if (!user?.address) return;

  const ctx = ctxOf();
  const settings = getSettings(c.from.id);
  const zeroForOne = side === "buy"; // buy EURC with USDC

  try {
    const amountIn =
      amount === "max"
        ? await maxBalance(ctx, user.address as `0x${string}`, zeroForOne)
        : BigInt(Math.floor(amount * 10 ** ctx.decimals));

    if (amountIn <= 0n) {
      await reply(c, "Not enough balance for that.", mainMenu());
      return;
    }

    const { quote, steps } = await planMarketSwap(ctx, {
      zeroForOne,
      amountIn,
      owner: user.address as `0x${string}`,
      slippageBps: settings.slippageBps,
    });

    const bookPct = Math.round(quote.bookShare * 100);
    const impact = (quote.priceImpactBps / 100).toFixed(2);
    const warn =
      quote.priceImpactBps > config.limits.highImpactWarnBps
        ? `\n\n⚠️ Price impact is ${impact}% — larger than usual for this size.`
        : "";

    const body =
      `*Confirm ${side}*\n\n` +
      `Pay: ${fmtUnits(amountIn, ctx.decimals)} ${zeroForOne ? "USDC" : "EURC"}\n` +
      `Receive: ~${fmtUnits(quote.expectedOut, ctx.decimals)} ${zeroForOne ? "EURC" : "USDC"}\n\n` +
      `Route: ${bookPct}% order book · ${100 - bookPct}% StableSwap\n` +
      (quote.improvementBps > 0
        ? `Better than AMM-only by ${(quote.improvementBps / 100).toFixed(2)}%\n`
        : "") +
      `Price impact: ${impact}%\n` +
      `Max slippage: ${(settings.slippageBps / 100).toFixed(2)}%` +
      warn +
      (steps.length > 1 ? `\n\n_Two signatures: approval, then the swap._` : "");

    recordTrade(c.from.id, "swap", body.replace(/\n/g, " ").slice(0, 200));
    // The last step is the swap; approval (if any) is surfaced in the Mini App.
    await reply(c, body, confirmKeyboard(steps[steps.length - 1]));
  } catch (e) {
    // Never surface a raw revert string to a user.
    const msg = e instanceof Error ? e.message : "Could not price that trade.";
    await reply(c, msg.slice(0, 200), mainMenu());
  }
}

async function maxBalance(ctx: Ctx, owner: `0x${string}`, zeroForOne: boolean): Promise<bigint> {
  const token = zeroForOne ? ctx.addresses.usdc : ctx.addresses.eurc;
  const bal = (await ctx.client.readContract({
    address: token,
    abi: [
      { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
    ] as const,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
  // Leave a little USDC behind for gas — it is the gas token on Arc.
  return zeroForOne && bal > 10_000n ? bal - 10_000n : bal;
}

async function reply(
  c: { editMessageText?: (t: string, e?: unknown) => Promise<unknown>; replyWithMarkdown: (t: string, e?: unknown) => Promise<unknown> },
  text: string,
  keyboard: unknown,
) {
  try {
    await c.editMessageText?.(text, { parse_mode: "Markdown", ...(keyboard as object) });
  } catch {
    await c.replyWithMarkdown(text, keyboard);
  }
}
