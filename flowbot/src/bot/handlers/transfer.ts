import type { Telegraf } from "telegraf";
import { backKeyboard, confirmKeyboard, mainMenu, walletSetupKeyboard } from "../keyboards";
import { getUser, recordTrade } from "../../db";
import { config } from "../../config";
import { planWithdraw, type TransferCtx } from "../../contracts/transfers";
import { fmtUnits } from "../../contracts/onyx";

/**
 * Deposit and withdraw.
 *
 * Deposits from other chains use Circle CCTP only — native burn-and-mint USDC,
 * no custom bridge and no wrapped asset.
 *
 * Withdrawals follow the same rule as every other fund-moving action: the bot
 * validates, prices and previews an UNSIGNED transaction; the Mini App signs it
 * on the user's device. A withdrawal to a mistyped address is the one mistake
 * here that cannot be undone, so the full destination is shown for checking
 * before the sign button appears.
 */

/** Users we're expecting a "address amount" message from. */
const awaiting = new Set<number>();

export function registerTransfer(bot: Telegraf, ctxOf: () => TransferCtx) {
  bot.action("deposit", async (c) => {
    await c.answerCbQuery();
    const user = getUser(c.from.id);
    if (!user?.address) return void c.editMessageText("Set up your wallet first.", walletSetupKeyboard());

    await c.editMessageText(
      `*Deposit*\n\n` +
        `Send USDC or EURC on *Arc Testnet* to:\n\`${user.address}\`\n\n` +
        `*From another chain*\n` +
        `Circle CCTP moves native USDC in — it burns on the source chain and mints ` +
        `real USDC here, so there's no wrapped token and no bridge to trust.\n\n` +
        `Arc's CCTP domain is *${config.cctp.arcDomain}*.`,
      { parse_mode: "Markdown", ...backKeyboard() },
    );
  });

  bot.action("withdraw", async (c) => {
    await c.answerCbQuery();
    const user = getUser(c.from.id);
    if (!user?.address) return void c.editMessageText("Set up your wallet first.", walletSetupKeyboard());

    awaiting.add(c.from.id);
    await c.editMessageText(
      `*Withdraw*\n\n` +
        `Send the destination and amount in one message:\n` +
        `\`0xAbC…123 25\`\n\n` +
        `Add a token to send EURC instead:\n` +
        `\`0xAbC…123 25 EURC\`\n\n` +
        `_Double-check the address — a transfer to the wrong one cannot be reversed._`,
      { parse_mode: "Markdown", ...backKeyboard() },
    );
  });

  // Runs after the trade handler's text listener, which calls next() when it
  // isn't expecting an amount.
  bot.on("text", async (c, next) => {
    if (!awaiting.has(c.from.id)) return next();

    const user = getUser(c.from.id);
    if (!user?.address) {
      awaiting.delete(c.from.id);
      return void c.reply("Set up your wallet first.", walletSetupKeyboard());
    }

    let thinking: { message_id: number } | undefined;
    try {
      thinking = await c.reply("Checking…");

      const { tx, parsed, fee, balance } = await planWithdraw(
        ctxOf(),
        user.address as `0x${string}`,
        c.message.text,
      );

      awaiting.delete(c.from.id);
      const decimals = ctxOf().decimals;

      const body =
        `*Confirm withdrawal*\n\n` +
        `Amount: *${fmtUnits(parsed.amount, decimals)} ${parsed.token}*\n` +
        `To:\n\`${parsed.to}\`\n\n` +
        `Your balance: ${fmtUnits(balance, decimals)} ${parsed.token}\n` +
        `Estimated fee: ~${fee} USDC\n\n` +
        `_Check the address above character by character. This cannot be reversed._`;

      recordTrade(c.from.id, "withdraw", `${fmtUnits(parsed.amount, decimals)} ${parsed.token} → ${parsed.to}`);

      if (thinking) await c.telegram.deleteMessage(c.chat.id, thinking.message_id).catch(() => undefined);
      await c.replyWithMarkdown(body, confirmKeyboard(tx));
    } catch (e) {
      // planWithdraw throws user-readable messages; anything else is generic.
      const msg =
        e instanceof Error && e.message.length < 300
          ? e.message
          : "Couldn't prepare that withdrawal. Please try again.";
      if (thinking) await c.telegram.deleteMessage(c.chat.id, thinking.message_id).catch(() => undefined);
      await c.reply(msg, backKeyboard());
      // Stay in withdraw mode so the user can simply correct their message.
    }
  });

  bot.action("menu", async (c, next) => {
    awaiting.delete(c.from.id);
    return next();
  });
}
