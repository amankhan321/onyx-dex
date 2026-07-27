import { Markup, type Telegraf } from "telegraf";
import { backKeyboard } from "../keyboards";
import { getSettings, updateSettings } from "../../db";
import { config } from "../../config";

/** Slippage, default amounts, notifications. */
export function registerSettings(bot: Telegraf) {
  const render = (id: number) => {
    const s = getSettings(id);
    return {
      text:
        `*Settings*\n\n` +
        `Slippage: ${(s.slippageBps / 100).toFixed(2)}%\n` +
        `Quick amounts: ${s.defaultAmounts.join(" / ")}\n` +
        `Fill alerts: ${s.notifications ? "on" : "off"}`,
      keyboard: Markup.inlineKeyboard([
        [25, 50, 100, 300]
          .filter((b) => b <= config.limits.maxSlippageBps)
          .map((b) => Markup.button.callback(`${b / 100}%`, `set:slip:${b}`)),
        [Markup.button.callback(s.notifications ? "🔕 Mute alerts" : "🔔 Enable alerts", "set:notif")],
        [Markup.button.callback("‹ Back", "menu")],
      ]),
    };
  };

  bot.action("settings", async (c) => {
    await c.answerCbQuery();
    const { text, keyboard } = render(c.from.id);
    await c.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  });

  bot.action(/^set:slip:(\d+)$/, async (c) => {
    const bps = Number((c.match as RegExpMatchArray)[1]);
    // Hard ceiling lives in config so no UI path can exceed it.
    updateSettings(c.from.id, { slippageBps: Math.min(bps, config.limits.maxSlippageBps) });
    await c.answerCbQuery("Slippage updated");
    const { text, keyboard } = render(c.from.id);
    await c.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  });

  bot.action("set:notif", async (c) => {
    const s = getSettings(c.from.id);
    updateSettings(c.from.id, { notifications: !s.notifications });
    await c.answerCbQuery();
    const { text, keyboard } = render(c.from.id);
    await c.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  });

  bot.action("noop", async (c) => void c.answerCbQuery());
  bot.action("back", async (c) => {
    await c.answerCbQuery();
    await c.editMessageText("What would you like to do?", backKeyboard());
  });
}
