import { type Telegraf } from "telegraf";
import { backKeyboard, confirmKeyboard, walletSetupKeyboard } from "../keyboards";
import { clearFlow, getFlow, setFlow } from "../state";
import { getSettings, getUser, recordTrade } from "../../db";
import { buildTwap, fmtUnits, type Ctx } from "../../contracts/onyx";
import { stableSwapAbi } from "../../contracts/abis";

/**
 * TWAP — slice a large order over time.
 *
 * The user gives total, slices and interval. The per-slice price floor is
 * derived from their slippage setting rather than asked for: it is the value
 * most likely to be set wrong by hand, and getting it wrong means either an
 * order that never executes or one that fills badly. It's shown in the
 * confirmation so the choice is visible, not hidden.
 */
export function registerTwap(bot: Telegraf, ctxOf: () => Ctx) {
  bot.action("twap", async (c) => {
    await c.answerCbQuery();
    if (!getUser(c.from.id)?.address) {
      return void c.editMessageText("Set up your wallet first.", walletSetupKeyboard());
    }
    setFlow(c.from.id, { kind: "twap", step: "total" });
    await c.editMessageText(
      "*TWAP*\n\nSpread a sell across time to reduce impact. Keepers execute each " +
        "slice; your price floor is enforced on-chain, so they can decline but never " +
        "fill you below it.\n\nSend the total USDC to sell, e.g. `20`",
      { parse_mode: "Markdown", ...backKeyboard() },
    );
  });

  bot.on("text", async (c, next) => {
    const flow = getFlow(c.from.id);
    if (flow?.kind !== "twap") return next();

    const n = Number(c.message.text.trim());
    if (!Number.isFinite(n) || n <= 0) {
      return void c.reply("That needs to be a positive number. Try again.");
    }

    if (flow.step === "total") {
      setFlow(c.from.id, { ...flow, total: n, step: "slices" });
      return void c.replyWithMarkdown(`Total: *${n}* USDC\n\nHow many slices? e.g. \`4\``);
    }

    if (flow.step === "slices") {
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        return void c.reply("Slices must be a whole number between 1 and 100.");
      }
      setFlow(c.from.id, { ...flow, slices: n, step: "interval" });
      return void c.replyWithMarkdown(`Slices: *${n}*\n\nMinutes between slices? e.g. \`5\``);
    }

    // step === "interval"
    const ctx = ctxOf();
    const total = flow.total!;
    const slices = flow.slices!;
    clearFlow(c.from.id);

    if (n < 1 || n > 1440) {
      return void c.reply("Interval must be between 1 and 1440 minutes.");
    }

    try {
      // Floor derived from the user's own slippage tolerance against the live price.
      const spot = (await ctx.client.readContract({
        address: ctx.addresses.stableSwap,
        abi: stableSwapAbi,
        functionName: "getDy",
        args: [true, BigInt(10 ** ctx.decimals)],
      })) as bigint;
      const price = Number(spot) / 10 ** ctx.decimals;
      const { slippageBps } = getSettings(c.from.id);
      const minPrice = price * (1 - slippageBps / 10_000);

      const totalAmount = BigInt(Math.round(total * 10 ** ctx.decimals));
      const intervalSeconds = Math.round(n * 60);

      const tx = buildTwap(ctx, {
        zeroForOne: true,
        totalAmount,
        slices,
        intervalSeconds,
        minPrice,
      });

      const perSlice = total / slices;
      const spanMinutes = n * (slices - 1);

      recordTrade(c.from.id, "twap", `${total} USDC / ${slices} slices / ${n}m`);

      await c.replyWithMarkdown(
        `*Confirm TWAP*\n\n` +
          `Sell *${fmtUnits(totalAmount, ctx.decimals)} USDC* in *${slices}* slices\n` +
          `≈ ${perSlice.toFixed(4)} USDC every ${n} min\n` +
          `Finishes in about ${spanMinutes} min\n\n` +
          `Current price: ${price.toFixed(5)}\n` +
          `Price floor: *${minPrice.toFixed(5)}* (your ${(slippageBps / 100).toFixed(2)}% slippage)\n\n` +
          `_Slices below the floor are skipped, not filled._`,
        confirmKeyboard(tx),
      );
    } catch {
      await c.reply("Couldn't price that TWAP just now. Please try again.", backKeyboard());
    }
  });
}
