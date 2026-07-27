import { Markup } from "telegraf";
import { config } from "../config";
import { miniAppUrl } from "../services/miniapp";
import type { UnsignedTx } from "../contracts/onyx";

/** BONKbot-style: everything reachable by tapping, typing only for amounts. */
export const mainMenu = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback("🟢 Buy", "buy"), Markup.button.callback("🔴 Sell", "sell")],
    [Markup.button.callback("📊 Positions", "positions"), Markup.button.callback("📋 Orders", "orders")],
    [Markup.button.callback("⬇️ Deposit", "deposit"), Markup.button.callback("⬆️ Withdraw", "withdraw")],
    [Markup.button.callback("⚙️ Settings", "settings"), Markup.button.callback("❓ Help", "help")],
  ]);

export const amountKeyboard = (side: "buy" | "sell", amounts: number[]) =>
  Markup.inlineKeyboard([
    amounts.map((a) => Markup.button.callback(`${a}`, `${side}:amt:${a}`)),
    [Markup.button.callback("Max", `${side}:amt:max`), Markup.button.callback("Custom", `${side}:amt:custom`)],
    [Markup.button.callback("‹ Back", "menu")],
  ]);

/** The confirm step opens the Mini App — the only place a key is ever touched. */
export const confirmKeyboard = (tx: UnsignedTx) =>
  Markup.inlineKeyboard([
    [Markup.button.webApp("✍️ Confirm & sign", miniAppUrl(config.telegram.miniAppUrl, tx))],
    [Markup.button.callback("Cancel", "menu")],
  ]);

export const walletSetupKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.webApp("🔐 Set up wallet", config.telegram.miniAppUrl)],
  ]);

export const backKeyboard = () =>
  Markup.inlineKeyboard([[Markup.button.callback("‹ Back", "menu")]]);
