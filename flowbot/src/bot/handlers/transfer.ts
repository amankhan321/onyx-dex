import type { Telegraf } from "telegraf";
import { backKeyboard, mainMenu } from "../keyboards";
import { getUser } from "../../db";
import { config } from "../../config";

/**
 * Deposit and withdraw.
 *
 * Deposits from other chains go through Circle CCTP only — native burn-and-mint
 * USDC, no custom bridge, no wrapped asset. The domain table is shown so a user
 * can verify where their funds are coming from.
 */
export function registerTransfer(bot: Telegraf) {
  bot.action("deposit", async (c) => {
    await c.answerCbQuery();
    const user = getUser(c.from.id);
    if (!user?.address) return void c.editMessageText("No wallet yet.", mainMenu());

    await c.editMessageText(
      `*Deposit*\n\n` +
        `Send USDC or EURC on *Arc Testnet* to:\n\`${user.address}\`\n\n` +
        `*From another chain*\n` +
        `Use Circle CCTP to move native USDC in — it burns on the source chain and ` +
        `mints real USDC here, so there's no wrapped token and no bridge to trust.\n\n` +
        `Arc's CCTP domain is *${config.cctp.arcDomain}*.`,
      { parse_mode: "Markdown", ...backKeyboard() },
    );
  });

  bot.action("withdraw", async (c) => {
    await c.answerCbQuery();
    await c.editMessageText(
      `*Withdraw*\n\n` +
        `Send the destination address and amount, e.g.\n` +
        `\`0xabc… 25\`\n\n` +
        `You'll get a confirmation screen before anything is signed.`,
      { parse_mode: "Markdown", ...backKeyboard() },
    );
  });
}
