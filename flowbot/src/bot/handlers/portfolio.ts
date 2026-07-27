import type { Telegraf } from "telegraf";
import { backKeyboard, mainMenu } from "../keyboards";
import { getUser, openOrders, recentTrades, referralCount } from "../../db";
import { erc20Abi } from "../../contracts/abis";
import { fmtUnits, type Ctx } from "../../contracts/onyx";

/** Positions, resting orders, history, referrals — all read-only. */
export function registerPortfolio(bot: Telegraf, ctxOf: () => Ctx) {
  bot.action("positions", async (c) => {
    await c.answerCbQuery();
    const user = getUser(c.from.id);
    if (!user?.address) return void c.editMessageText("No wallet yet.", mainMenu());

    const ctx = ctxOf();
    try {
      const [usdc, eurc] = (await Promise.all([
        ctx.client.readContract({ address: ctx.addresses.usdc, abi: erc20Abi, functionName: "balanceOf", args: [user.address as `0x${string}`] }),
        ctx.client.readContract({ address: ctx.addresses.eurc, abi: erc20Abi, functionName: "balanceOf", args: [user.address as `0x${string}`] }),
      ])) as [bigint, bigint];

      await c.editMessageText(
        `*Positions*\n\n` +
          `USDC: ${fmtUnits(usdc, ctx.decimals)}\n` +
          `EURC: ${fmtUnits(eurc, ctx.decimals)}\n\n` +
          `\`${user.address}\``,
        { parse_mode: "Markdown", ...backKeyboard() },
      );
    } catch {
      await c.editMessageText("Couldn't read balances just now. Try again shortly.", backKeyboard());
    }
  });

  bot.action("orders", async (c) => {
    await c.answerCbQuery();
    const orders = openOrders(c.from.id);
    if (orders.length === 0) {
      return void c.editMessageText("No resting orders.", backKeyboard());
    }
    const lines = orders
      .map((o) => `• ${o.side === "bid" ? "Buy" : "Sell"} ${o.size} @ ${o.price} — #${o.orderId}`)
      .join("\n");
    await c.editMessageText(`*Open orders*\n\n${lines}`, {
      parse_mode: "Markdown",
      ...backKeyboard(),
    });
  });

  bot.action("history", async (c) => {
    await c.answerCbQuery();
    const rows = recentTrades(c.from.id);
    const body = rows.length
      ? rows.map((r) => `• ${new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")} — ${r.kind}`).join("\n")
      : "Nothing yet.";
    await c.editMessageText(`*Recent activity*\n\n${body}`, {
      parse_mode: "Markdown",
      ...backKeyboard(),
    });
  });

  bot.command("referral", async (c) => {
    const me = await c.telegram.getMe();
    const link = `https://t.me/${me.username}?start=${c.from.id}`;
    await c.replyWithMarkdown(
      `*Your referral link*\n\`${link}\`\n\nReferred so far: ${referralCount(c.from.id)}`,
    );
  });
}
