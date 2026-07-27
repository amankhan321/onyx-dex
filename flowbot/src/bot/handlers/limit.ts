import { Markup, type Context, type Telegraf } from "telegraf";
import { backKeyboard, confirmKeyboard, walletSetupKeyboard } from "../keyboards";
import { clearFlow, getFlow, setFlow } from "../state";
import { getUser, openOrders, recordTrade } from "../../db";
import { buildCancelOrder, buildLimitOrder, fmtUnits, type Ctx } from "../../contracts/onyx";

/**
 * Limit orders — place, list, cancel.
 *
 * Placement reuses buildLimitOrder(), which reads the live book and refuses an
 * order that would cross the spread. That check happens BEFORE the user is asked
 * to sign, so a post-only rejection never reaches the chain as a failed tx the
 * user has to interpret.
 *
 * Cancelling moves funds (escrow comes back), so it goes through the same
 * Mini App signing flow as everything else — the bot cannot cancel on a user's
 * behalf any more than it can trade for them.
 */
export function registerLimit(bot: Telegraf, ctxOf: () => Ctx) {
  bot.action("limit", async (c) => {
    await c.answerCbQuery();
    if (!getUser(c.from.id)?.address) {
      return void c.editMessageText("Set up your wallet first.", walletSetupKeyboard());
    }
    await c.editMessageText(
      "*Limit order*\n\nResting orders sit on the book until someone trades against them.",
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("🟢 Buy USDC", "limit:bid"),
            Markup.button.callback("🔴 Sell USDC", "limit:ask"),
          ],
          [Markup.button.callback("📋 My open orders", "orders")],
          [Markup.button.callback("‹ Back", "menu")],
        ]),
      },
    );
  });

  bot.action(/^limit:(bid|ask)$/, async (c) => {
    await c.answerCbQuery();
    const side = (c.match as RegExpMatchArray)[1] as "bid" | "ask";
    setFlow(c.from.id, { kind: "limit", side, step: "price" });

    let hint = "";
    try {
      const ctx = ctxOf();
      const [bestBid, bestAsk] = await Promise.all([
        ctx.client.readContract({ address: ctx.addresses.orderBook, abi: (await import("../../contracts/abis")).orderBookAbi, functionName: "bestBid" }),
        ctx.client.readContract({ address: ctx.addresses.orderBook, abi: (await import("../../contracts/abis")).orderBookAbi, functionName: "bestAsk" }),
      ]);
      const bid = Number(bestBid) * 1e-5;
      const ask = Number(bestAsk) * 1e-5;
      hint =
        `\n\nBest bid: ${bid > 0 ? bid.toFixed(5) : "—"}  ·  Best ask: ${ask > 0 ? ask.toFixed(5) : "—"}` +
        (side === "bid"
          ? ask > 0
            ? `\n_Your price must be below ${ask.toFixed(5)}._`
            : ""
          : bid > 0
            ? `\n_Your price must be above ${bid.toFixed(5)}._`
            : "");
    } catch {
      /* a missing hint is cosmetic; the on-chain guard still applies */
    }

    await c.editMessageText(
      `*${side === "bid" ? "Buy" : "Sell"} USDC — limit*\n\nSend the price in EURC per USDC, e.g. \`0.8750\`${hint}`,
      { parse_mode: "Markdown", ...backKeyboard() },
    );
  });

  bot.action(/^cancelorder:(\d+)$/, async (c) => {
    await c.answerCbQuery();
    const id = (c.match as RegExpMatchArray)[1];
    const tx = buildCancelOrder(ctxOf(), BigInt(id));
    await c.editMessageText(
      `*Cancel order #${id}*\n\nYour escrow returns to claimable once this confirms.`,
      { parse_mode: "Markdown", ...confirmKeyboard(tx) },
    );
  });

  bot.on("text", async (c, next) => {
    const flow = getFlow(c.from.id);
    if (flow?.kind !== "limit") return next();

    const n = Number(c.message.text.trim());
    if (!Number.isFinite(n) || n <= 0) {
      return void c.reply("That needs to be a positive number. Try again.");
    }

    if (flow.step === "price") {
      setFlow(c.from.id, { ...flow, price: n, step: "amount" });
      return void c.replyWithMarkdown(
        `Price: *${n.toFixed(5)}*\n\nNow send the size in USDC, e.g. \`5\``,
      );
    }

    // step === "amount"
    const ctx = ctxOf();
    const price = flow.price!;
    clearFlow(c.from.id);

    try {
      const baseAmount = BigInt(Math.round(n * 10 ** ctx.decimals));
      const tx = await buildLimitOrder(ctx, {
        isBid: flow.side === "bid",
        price,
        baseAmount,
      });

      const escrow =
        flow.side === "bid"
          ? `${(price * n).toFixed(4)} EURC`
          : `${n.toFixed(4)} USDC`;

      recordTrade(c.from.id, "limit", `${flow.side} ${n} @ ${price}`);

      await c.replyWithMarkdown(
        `*Confirm limit order*\n\n` +
          `${flow.side === "bid" ? "Buy" : "Sell"} *${fmtUnits(baseAmount, ctx.decimals)} USDC* @ *${price.toFixed(5)}* EURC\n` +
          `Escrow locked: ${escrow}\n\n` +
          `_Post-only: this rests on the book. It fills when someone trades into it._`,
        confirmKeyboard(tx),
      );
    } catch (e) {
      // buildLimitOrder throws the crossing explanation — surface it verbatim,
      // it is written for the user.
      const msg = e instanceof Error && e.message.length < 300 ? e.message : "Couldn't build that order.";
      await c.reply(msg, backKeyboard());
    }
  });
}

/** Adds a Cancel button to each resting order in the list view. */
export function ordersKeyboard(telegramId: number) {
  const rows = openOrders(telegramId).map((o) => [
    Markup.button.callback(`✕ ${o.side === "bid" ? "Buy" : "Sell"} ${o.size} @ ${o.price}`, `cancelorder:${o.orderId}`),
  ]);
  rows.push([Markup.button.callback("‹ Back", "menu")]);
  return Markup.inlineKeyboard(rows);
}

export type { Context };
