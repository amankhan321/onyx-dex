/**
 * FX rate keeper.
 *
 * The StableSwap halts when the oracle goes stale — deliberately, so it can
 * never price off a dead feed. Something has to keep the feed alive, and
 * nothing did: that is why trading stopped.
 *
 * Run every 30 minutes. Reads the on-chain rate, fetches a public ECB
 * reference, and pushes a bounded step toward it — or a heartbeat when the
 * market hasn't moved, because a fresh timestamp is the whole point.
 *
 * SECRET HANDLING: the updater key is read from RATE_UPDATER_KEY in the
 * environment and used only to construct the account. It is never logged,
 * never passed as an argument, and no signed transaction is ever printed.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, ADDR, rateAbi } from "../web/lib/contracts";
import {
  ALERT_AFTER,
  decide,
  formatAge,
  fromWad,
  STALENESS_WINDOW,
  toWad,
  validateFeedRate,
} from "../web/lib/rateKeeper";

const FEED = "https://api.frankfurter.app/latest?from=EUR&to=USD";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function fetchEurUsd(): Promise<number> {
  const res = await fetch(FEED, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  const json = (await res.json()) as { rates?: Record<string, unknown> };
  // validateFeedRate throws on anything non-finite or outside the sane band, so
  // a broken feed aborts the run rather than being signed into the oracle.
  return validateFeedRate(json?.rates?.USD);
}

async function main() {
  const key = process.env.RATE_UPDATER_KEY;
  if (!key) fail("RATE_UPDATER_KEY is not set");
  const pk = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;

  let account;
  try {
    account = privateKeyToAccount(pk);
  } catch {
    // Never echo the value, not even a prefix.
    fail("RATE_UPDATER_KEY is not a valid private key");
  }

  const rpc = process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
  const publicClient = createPublicClient({
    chain: arcTestnet,
    transport: http(rpc, { batch: false, retryCount: 2, timeout: 15_000 }),
  });

  const provider = ADDR.rateProvider as `0x${string}`;

  const [currentWad, updatedAt, block] = await Promise.all([
    publicClient.readContract({ address: provider, abi: rateAbi, functionName: "rate" }) as Promise<bigint>,
    publicClient.readContract({ address: provider, abi: rateAbi, functionName: "updatedAt" }) as Promise<bigint>,
    publicClient.getBlock(),
  ]);

  const now = Number(block.timestamp);
  const ageSeconds = now - Number(updatedAt);

  const market = await fetchEurUsd();
  const targetWad = toWad(market);

  console.log(`on-chain rate : ${fromWad(currentWad).toFixed(6)}`);
  console.log(`age           : ${formatAge(ageSeconds)}${ageSeconds > STALENESS_WINDOW ? "  ← STALE, swaps halted" : ""}`);
  console.log(`market (ECB)  : ${market.toFixed(6)}`);

  const decision = decide({ ageSeconds, currentWad, targetWad });
  console.log(`decision      : ${decision.action} — ${decision.reason}`);

  if (decision.action === "skip") {
    if (ageSeconds > ALERT_AFTER) {
      console.warn(`⚠ rate is ${formatAge(ageSeconds)} old and this run pushed nothing`);
    }
    return;
  }

  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc, { batch: false }) });
  const hash = await wallet.writeContract({
    address: provider,
    abi: rateAbi,
    functionName: "setRate",
    args: [decision.value],
    chain: arcTestnet,
  });

  console.log(`new rate      : ${fromWad(decision.value).toFixed(6)}`);
  console.log(`tx            : ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== "success") fail(`transaction reverted: ${hash}`);
  console.log(`✓ confirmed in block ${receipt.blockNumber}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
