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
import { activeAlerts, getSettings, markAlertTriggered, markOrder, openOrders } from "../db";
import { stableSwapAbi } from "../contracts/abis";

type Deps = {
  bot: Telegraf;
  client: PublicClient;
  orderBook: `0x${string}`;
  stableSwap: `0x${string}`;
  decimals: number;
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

/**
 * Price alerts. Fires once per alert, then marks it triggered — a threshold that
 * re-fired every 30s while the price sat above it would be unusable.
 */
export async function sweepAlerts({ bot, client, stableSwap, decimals }: Deps) {
  const alerts = activeAlerts();
  if (alerts.length === 0) return;

  let price: number;
  try {
    const dy = (await client.readContract({
      address: stableSwap,
      abi: stableSwapAbi,
      functionName: "getDy",
      args: [true, BigInt(10 ** decimals)],
    })) as bigint;
    price = Number(dy) / 10 ** decimals;
  } catch {
    return; // an unreadable price is not a reason to fire anything
  }
  if (!(price > 0)) return;

  for (const a of alerts) {
    const hit = a.direction === "above" ? price >= a.price : price <= a.price;
    if (!hit) continue;
    markAlertTriggered(a.id);
    if (!getSettings(a.telegramId).notifications) continue;
    try {
      await bot.telegram.sendMessage(
        a.telegramId,
        `🔔 *Price alert*\n\nUSDC/EURC is ${price.toFixed(5)} — ${a.direction} your ${a.price.toFixed(5)} threshold.`,
        { parse_mode: "Markdown" },
      );
    } catch {
      continue; // a blocked chat must not stall the rest
    }
  }
}

export function startFillWatcher(deps: Deps, intervalMs = 30_000) {
  const tick = () => {
    void sweepFills(deps).catch(() => undefined);
    void sweepAlerts(deps).catch(() => undefined);
  };
  tick();
  return setInterval(tick, intervalMs);
}
