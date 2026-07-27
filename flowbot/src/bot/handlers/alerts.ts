import { Markup, type Telegraf } from "telegraf";
import { backKeyboard } from "../keyboards";
import { clearFlow, getFlow, setFlow } from "../state";
import { activeAlerts, addAlert, deleteAlert, referralCount } from "../../db";
import { config } from "../../config";

/**
 * Price alerts and the referral screen.
 *
 * Alerts are read-only — nothing here can move funds, so there is no signing
 * step. They are stored as a threshold and a direction, which is about as
 * non-sensitive as data gets.
 */
export function registerAlerts(bot: Telegraf) {
  const render = (id: number) => {
    const list = activeAlerts(id);
    const body = list.length
      ? list.map((a) => `• ${a.direction} ${a.price.toFixed(5)}`).join("\n")
      : "_No alerts set._";
    const rows = list.map((a) => [
      Markup.button.callback(`✕ ${a.direction} ${a.price.toFixed(5)}`, `alert:del:${a.id}`),
    ]);
    rows.unshift([
      Markup.button.callback("↑ Alert above", "alert:new:above"),
      Markup.button.callback("↓ Alert below", "alert:new:below"),
    ]);
    rows.push([Markup.button.callback("‹ Back", "menu")]);
    return { text: `*Price alerts*\n\nEURC per USDC.\n\n${body}`, keyboard: Markup.inlineKeyboard(rows) };
  };

  bot.action("alerts", async (c) => {
    await c.answerCbQuery();
    const { text, keyboard } = render(c.from.id);
    await c.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  });

  bot.action(/^alert:new:(above|below)$/, async (c) => {
    await c.answerCbQuery();
    const direction = (c.match as RegExpMatchArray)[1] as "above" | "below";
    setFlow(c.from.id, { kind: "alert", step: "price", direction });
    await c.editMessageText(
      `Send the price to alert *${direction}*, e.g. \`0.9000\``,
      { parse_mode: "Markdown", ...backKeyboard() },
    );
  });

  bot.action(/^alert:del:(\d+)$/, async (c) => {
    deleteAlert(c.from.id, Number((c.match as RegExpMatchArray)[1]));
    await c.answerCbQuery("Removed");
    const { text, keyboard } = render(c.from.id);
    await c.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  });

  bot.action("referral", async (c) => {
    await c.answerCbQuery();
    const me = await c.telegram.getMe();
    const link = `https://t.me/${me.username}?start=${c.from.id}`;
    const feeLine =
      config.referral.feeBps > 0
        ? `\n\nYou earn *${(config.referral.feeBps / 100).toFixed(2)}%* of the trading fees ` +
          `from people you refer. This is disclosed to them on signup.`
        : `\n\n_Fee sharing is currently off._`;
    await c.editMessageText(
      `*Your referral link*\n\n\`${link}\`\n\nReferred so far: *${referralCount(c.from.id)}*${feeLine}`,
      { parse_mode: "Markdown", ...backKeyboard() },
    );
  });

  bot.on("text", async (c, next) => {
    const flow = getFlow(c.from.id);
    if (flow?.kind !== "alert") return next();
    const n = Number(c.message.text.trim());
    if (!Number.isFinite(n) || n <= 0) {
      return void c.reply("That needs to be a positive number. Try again.");
    }
    clearFlow(c.from.id);
    addAlert(c.from.id, flow.direction, n);
    await c.replyWithMarkdown(
      `Alert set: I'll message you when the price goes *${flow.direction} ${n.toFixed(5)}*.`,
      backKeyboard(),
    );
  });
}
