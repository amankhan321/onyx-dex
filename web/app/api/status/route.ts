import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import { ADDR, arcTestnet, rateAbi } from "@/lib/contracts";
import { STALENESS_WINDOW } from "@/lib/rateKeeper";

/**
 * Read-only oracle status, so every surface tells the same story.
 *
 * Before this, each panel discovered staleness independently by catching a
 * revert, which is how the same condition rendered as em-dashes in one place
 * and a raw selector in another.
 *
 * No secrets in the payload — this is public chain state.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const client = createPublicClient({
    chain: arcTestnet,
    transport: http(undefined, { batch: false, retryCount: 2, timeout: 12_000 }),
  });

  try {
    const [rate, updatedAt, block] = await Promise.all([
      client.readContract({ address: ADDR.rateProvider as `0x${string}`, abi: rateAbi, functionName: "rate" }) as Promise<bigint>,
      client.readContract({ address: ADDR.rateProvider as `0x${string}`, abi: rateAbi, functionName: "updatedAt" }) as Promise<bigint>,
      client.getBlock(),
    ]);

    const ageSeconds = Number(block.timestamp) - Number(updatedAt);
    return NextResponse.json(
      {
        rate: Number(rate) / 1e18,
        updatedAt: Number(updatedAt),
        ageSeconds,
        stale: ageSeconds > STALENESS_WINDOW,
        stalenessWindow: STALENESS_WINDOW,
        // The keeper's last successful push IS updatedAt — there is no separate
        // bookkeeping to drift out of sync with the chain.
        lastKeeperRun: Number(updatedAt),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message.slice(0, 120) : "status unavailable" },
      { status: 502 },
    );
  }
}
