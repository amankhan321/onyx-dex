import type { Telegraf } from "telegraf";
import { mainMenu, walletSetupKeyboard } from "../keyboards";
import { getUser, upsertUser } from "../../db";

/**
 * /start — onboarding and the self-custody disclosure.
 *
 * The custody paragraph is not boilerplate: it is the one thing a user must
 * understand before they put money in, so it appears before any trading UI and
 * says plainly that nobody can recover their funds.
 */
export function registerStart(bot: Telegraf) {
  bot.start(async (ctx) => {
    const id = ctx.from.id;
    // /start <referrerId> — only credited on first contact.
    const payload = (ctx.payload ?? "").trim();
    const referrer = /^\d+$/.test(payload) && Number(payload) !== id ? Number(payload) : undefined;

    const existing = getUser(id);
    upsertUser(id, ctx.from.username, existing ? undefined : referrer);

    const hasWallet = Boolean(existing?.address);

    await ctx.replyWithMarkdown(
      `*FlowBot* — trading on Onyx, the order book DEX on Arc.\n\n` +
        `*This is self-custody.*\n` +
        `Your wallet is created and unlocked on your own device. Your password and ` +
        `private key never reach our servers — we hold only an encrypted file we ` +
        `cannot open.\n\n` +
        `That means *nobody can recover your funds for you.* Not us, not Telegram. ` +
        `Your recovery phrase is the only backup, and you are shown it exactly once.\n\n` +
        (hasWallet ? `Wallet ready. What would you like to do?` : `Set up your wallet to begin.`),
      hasWallet ? mainMenu() : walletSetupKeyboard(),
    );
  });

  bot.action("menu", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("What would you like to do?", mainMenu());
  });

  bot.action("help", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "Buy / Sell — market orders routed through the book first, then the curve.\n" +
        "Orders — resting limit orders and TWAPs.\n" +
        "Deposit — bring USDC in from another chain via Circle CCTP.\n" +
        "Withdraw — send to any address.\n\n" +
        "Every action opens a signing screen on your device. If you lose your " +
        "recovery phrase, the wallet cannot be restored.",
      mainMenu(),
    );
  });
}
