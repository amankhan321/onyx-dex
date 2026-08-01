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
 * Lives under web/ deliberately: Node resolves modules from the script's own
 * directory, so a copy at the repo root could not see web/node_modules no
 * matter what working-directory the workflow set. That was run #1's failure.
 *
 * SECRET HANDLING: the updater key is read from RATE_UPDATER_KEY in the
 * environment and used only to construct the account. It is never logged,
 * never passed as an argument, and no signed transaction is ever printed.
 */
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, ADDR, rateAbi } from "../lib/contracts";
import { withRetry, isRateLimited } from "../lib/rpcRetry";
import { EUR_USD_SOURCES, fetchFirst } from "../lib/fxFeeds";
import {
  ALERT_AFTER,
  decide,
  formatAge,
  fromWad,
  STALENESS_WINDOW,
  toWad,
  validateFeedRate,
} from "../lib/rateKeeper";

/** Short, safe error text. Never a full request body — it can carry a payload. */
function short(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  return s.split("\n")[0].slice(0, 100);
}

/**
 * Tell the operator when a run fails. The keeper dying silently is why a stale
 * oracle was first noticed by users unable to swap, not by us.
 */
async function notifyAdmin(reason: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chat) return;
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        parse_mode: "Markdown",
        text:
          `🔴 *FX rate keeper failed*\n\n${reason}\n\n` +
          "Swaps halt once the rate passes 6h old." +
          (runUrl ? `\n\n[Run log](${runUrl})` : ""),
      }),
    });
  } catch {
    /* best-effort; the alert must never mask the original failure */
  }
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  // Fire-and-forget: exit is deferred a moment so the alert can leave.
  void notifyAdmin(message).finally(() => process.exit(1));
  // Unreachable in practice; satisfies the never return type.
  throw new Error(message);
}

async function fetchEurUsd(): Promise<{ rate: number; source: string }> {
  const { value, source } = await fetchFirst(EUR_USD_SOURCES, (json, s) => {
    const v = s.extract(json);
    if (v === undefined) return null;
    // validateFeedRate throws on anything non-finite or outside the sane band,
    // so a broken feed aborts the run rather than being signed into the oracle.
    return validateFeedRate(v);
  });
  return { rate: value, source };
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

  // ONE multicall for both reads, then one block fetch — the fewest calls a run
  // can make. Run #21 died on a bare updatedAt() that hit -32011 with no retry.
  const [currentWad, updatedAt] = await withRetry(
    () =>
      publicClient.multicall({
        allowFailure: false,
        contracts: [
          { address: provider, abi: rateAbi, functionName: "rate" },
          { address: provider, abi: rateAbi, functionName: "updatedAt" },
        ],
      }) as Promise<[bigint, bigint]>,
    { onRetry: (n, e, ms) => console.log(`read attempt ${n} failed (${short(e)}), retrying in ${Math.round(ms)}ms`) },
  );

  const block = await withRetry(() => publicClient.getBlock(), {
    onRetry: (n, e, ms) => console.log(`block attempt ${n} failed (${short(e)}), retrying in ${Math.round(ms)}ms`),
  });

  const now = Number(block.timestamp);
  const ageSeconds = now - Number(updatedAt);

  const { rate: market, source: fxSource } = await fetchEurUsd();
  const targetWad = toWad(market);

  console.log(`on-chain rate : ${fromWad(currentWad).toFixed(6)}`);
  console.log(`age           : ${formatAge(ageSeconds)}${ageSeconds > STALENESS_WINDOW ? "  ← STALE, swaps halted" : ""}`);
  console.log(`market (ECB)  : ${market.toFixed(6)}  via ${fxSource}`);

  const decision = decide({ ageSeconds, currentWad, targetWad });
  console.log(`decision      : ${decision.action} — ${decision.reason}`);

  if (decision.action === "skip") {
    if (ageSeconds > ALERT_AFTER) {
      console.warn(`⚠ rate is ${formatAge(ageSeconds)} old and this run pushed nothing`);
    }
    return;
  }

  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(rpc, { batch: false }) });
  const send = () =>
    wallet.writeContract({
      address: provider,
      abi: rateAbi,
      functionName: "setRate",
      args: [decision.value],
      chain: arcTestnet,
    });

  // Re-sending is safe: the same signed transaction has the same hash, so a
  // duplicate is either already known or accepted once. Only rate limiting and
  // transport failures retry — a revert or nonce error is a real answer.
  let hash: `0x${string}`;
  try {
    hash = await send();
  } catch (e) {
    if (!isRateLimited(e)) throw e;
    console.log(`send rate-limited (${short(e)}), retrying once`);
    hash = await withRetry(send, { attempts: 3 });
  }

  console.log(`new rate      : ${fromWad(decision.value).toFixed(6)}`);
  console.log(`tx            : ${hash}`);

  const receipt = await withRetry(
    () => publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 }),
    { attempts: 3 },
  );
  if (receipt.status !== "success") fail(`transaction reverted: ${hash}`);
  console.log(`✓ confirmed in block ${receipt.blockNumber}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
