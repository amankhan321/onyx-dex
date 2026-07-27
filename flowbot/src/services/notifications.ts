/**
 * Fill notifications.
 *
 * Polls the tracked orders we're watching and pushes a Telegram message the
 * first time one is no longer resting. Reads chain state directly rather than
 * trusting our own record, so a fill that happened while the process was down is
 * still caught on the next sweep.
 */
import type { Telegraf } from "telegraf";
import type { PublicClient } from "viem";
import { orderBookAbi } from "../contracts/abis";
import { getSettings, markOrder, openOrders } from "../db";

type Deps = {
  bot: Telegraf;
  client: PublicClient;
  orderBook: `0x${string}`;
  explorer: string;
};

/** viem returns public struct getters as a POSITIONAL array, not an object. */
type OrderTuple = [string, number, boolean, boolean, bigint, bigint, bigint, bigint, bigint];

export async function sweepFills({ bot, client, orderBook, explorer }: Deps) {
  const watching = openOrders();
  if (watching.length === 0) return;

  for (const o of watching) {
    try {
      const res = (await client.readContract({
        address: orderBook,
        abi: orderBookAbi,
        functionName: "orders",
        args: [BigInt(o.orderId)],
      })) as unknown as OrderTuple;

      const active = res[3];
      const baseAmount = res[4];
      const baseFilled = res[5];

      const fullyGone = !active || baseFilled >= baseAmount;
      if (!fullyGone) continue;

      markOrder(o.orderId, baseFilled > 0n ? "filled" : "cancelled");

      if (baseFilled === 0n) continue; // cancelled, not filled — nothing to announce
      if (!getSettings(o.telegramId).notifications) continue;

      await bot.telegram.sendMessage(
        o.telegramId,
        `✅ *Order filled*\n\n` +
          `${o.side === "bid" ? "Bought" : "Sold"} ${o.size} USDC @ ${o.price} EURC\n` +
          (o.txHash ? `[View on Arcscan](${explorer}/tx/${o.txHash})` : ""),
        { parse_mode: "Markdown" },
      );
    } catch {
      // A single unreadable order must not stop the sweep for everyone else.
      continue;
    }
  }
}

export function startFillWatcher(deps: Deps, intervalMs = 30_000) {
  const tick = () => void sweepFills(deps).catch(() => undefined);
  tick();
  return setInterval(tick, intervalMs);
}
