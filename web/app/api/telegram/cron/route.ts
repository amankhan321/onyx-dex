import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { ADDR, arcTestnet, bookAbi, poolAbi, rateAbi } from "@/lib/contracts";
import { ALERT_AFTER, STALENESS_WINDOW, formatAge } from "@/lib/rateKeeper";
import {
  activeAlerts,
  ensureSchema,
  markAlertTriggered,
  markOrder,
  notificationsOn,
  openOrders,
} from "@/lib/bot/db";
import { sendMessage } from "@/lib/bot/telegram";

/**
 * Fill and price-alert sweep.
 *
 * WHY AN EXTERNAL CRON, NOT VERCEL CRON: Hobby plans run scheduled functions
 * once a DAY, which is useless for "your order filled". WHY NOT THE DROPLET
 * KEEPER: updating it needs shell access, and the whole point of this change was
 * to remove that requirement. So a GitHub Actions schedule pings this route
 * every 5 minutes — it's already in the repo, configurable from a browser, and
 * costs nothing.
 *
 * Protected by the admin secret: anyone who could call this could spam users
 * with notifications.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const client = createPublicClient({
  chain: arcTestnet,
  // batch:false — Arc's RPC intermittently drops batched eth_calls.
  transport: http(undefined, { batch: false, retryCount: 2, timeout: 12_000 }),
});

/** viem returns public struct getters as a POSITIONAL array, not an object. */
type OrderTuple = [string, number, boolean, boolean, bigint, bigint, bigint, bigint, bigint];

export async function POST(req: Request) {
  const admin = process.env.TELEGRAM_ADMIN_SECRET;
  if (!admin) return NextResponse.json({ error: "not configured" }, { status: 503 });
  if (req.headers.get("x-admin-secret") !== admin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  await ensureSchema();
  const result = { fills: 0, alerts: 0, errors: 0, rateAgeSeconds: 0 };

  // ---- oracle freshness: the early warning that was missing ----
  // Swaps halt at 6h. Warning at 4h leaves two hours to notice and act, rather
  // than discovering it from a user reporting that trading is broken.
  try {
    const [updatedAt, block] = await Promise.all([
      client.readContract({ address: ADDR.rateProvider as `0x${string}`, abi: rateAbi, functionName: "updatedAt" }) as Promise<bigint>,
      client.getBlock(),
    ]);
    const age = Number(block.timestamp) - Number(updatedAt);
    result.rateAgeSeconds = age;

    const adminChat = process.env.TELEGRAM_ADMIN_CHAT_ID;
    if (age > ALERT_AFTER && adminChat) {
      await sendMessage(
        Number(adminChat),
        age > STALENESS_WINDOW
          ? `🔴 *FX rate stale — swaps are HALTED*\n\nLast update ${formatAge(age)} ago. The rate keeper is not pushing; check the FX rate keeper workflow.`
          : `⚠️ *FX rate ${formatAge(age)} stale*\n\nSwaps halt at ${formatAge(STALENESS_WINDOW)}. Check the FX rate keeper workflow.`,
      );
      result.alerts++;
    }
  } catch {
    result.errors++;
  }

  // ---- fills ----
  for (const o of await openOrders()) {
    try {
      const res = (await client.readContract({
        address: ADDR.book as `0x${string}`,
        abi: bookAbi,
        functionName: "orders",
        args: [BigInt(o.order_id)],
      })) as unknown as OrderTuple;

      const [, , , active, baseAmount, baseFilled] = res;
      if (active && baseFilled < baseAmount) continue;

      // A cancel is not a fill. Announcing one as the other would be worse than
      // staying silent, so the two are distinguished before anything is sent.
      const filled = baseFilled > 0n;
      await markOrder(o.order_id, filled ? "filled" : "cancelled");
      if (!filled) continue;
      if (!(await notificationsOn(o.telegram_id))) continue;

      await sendMessage(
        Number(o.telegram_id),
        `✅ *Order filled*\n\n${o.side === "bid" ? "Bought" : "Sold"} ${o.size} USDC @ ${o.price} EURC` +
          (o.tx_hash ? `\n\n[View on Arcscan](https://testnet.arcscan.app/tx/${o.tx_hash})` : ""),
      );
      result.fills++;
    } catch {
      // One unreadable order must not stop the sweep for everyone else.
      result.errors++;
    }
  }

  // ---- price alerts ----
  const alerts = await activeAlerts();
  if (alerts.length > 0) {
    try {
      const dy = (await client.readContract({
        address: ADDR.pool as `0x${string}`,
        abi: poolAbi,
        functionName: "getDy",
        args: [true, 1_000_000n],
      })) as bigint;
      const price = Number(dy) / 1e6;

      if (price > 0) {
        for (const a of alerts) {
          const target = Number(a.price);
          const hit = a.direction === "above" ? price >= target : price <= target;
          if (!hit) continue;
          // Fire once, then retire it — a threshold that re-fired every sweep
          // while the price sat above it would be unusable.
          await markAlertTriggered(a.id);
          if (!(await notificationsOn(a.telegram_id))) continue;
          await sendMessage(
            Number(a.telegram_id),
            `🔔 *Price alert*\n\nUSDC/EURC is ${price.toFixed(5)} — ${a.direction} your ${target.toFixed(5)} threshold.`,
          );
          result.alerts++;
        }
      }
    } catch {
      result.errors++;
    }
  }

  return NextResponse.json({ ok: true, ...result });
}
