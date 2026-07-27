/**
 * Boot-time configuration validation.
 *
 * The failure this exists to prevent: a wrong RPC or chain ID doesn't error —
 * it succeeds against the wrong network. Transactions get signed, broadcast and
 * confirmed somewhere the user never intended. By the time anyone notices, funds
 * have moved. So the bot refuses to start rather than run on config it can't
 * vouch for.
 *
 * Two layers:
 *   1. Static — every required var is present, well-formed, and not still a
 *      placeholder.
 *   2. Live — the RPC is asked what chain it actually is, and the answer must
 *      match ARC_CHAIN_ID. This is the one that catches a copy-pasted URL from
 *      the wrong network, which no amount of string checking would spot.
 */

import { createPublicClient, http, isAddress } from "viem";

/** Values that mean "nobody filled this in yet". */
const PLACEHOLDERS = [
  "",
  "unverified",
  "verify",
  "todo",
  "changeme",
  "your-token-here",
  "0x0000000000000000000000000000000000000000",
];

type Problem = { name: string; reason: string };

const isPlaceholder = (v: string | undefined) =>
  v === undefined || PLACEHOLDERS.includes(v.trim().toLowerCase());

function requireVar(name: string, problems: Problem[]): string | undefined {
  const v = process.env[name];
  if (isPlaceholder(v)) {
    problems.push({ name, reason: "missing, empty, or still a placeholder" });
    return undefined;
  }
  return v!.trim();
}

function requireAddress(name: string, problems: Problem[]) {
  const v = requireVar(name, problems);
  if (v === undefined) return;
  if (!isAddress(v)) {
    problems.push({ name, reason: `"${v}" is not a valid 0x address` });
  }
}

function requireHttpsUrl(name: string, problems: Problem[], allowHttp = false) {
  const v = requireVar(name, problems);
  if (v === undefined) return;
  try {
    const u = new URL(v);
    if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) {
      problems.push({ name, reason: `must be https (got ${u.protocol})` });
    }
  } catch {
    problems.push({ name, reason: `"${v}" is not a valid URL` });
  }
}

/** Static checks. Returns every problem at once, so one restart shows them all. */
export function validateStatic(): Problem[] {
  const problems: Problem[] = [];

  // Telegram
  const token = requireVar("TELEGRAM_BOT_TOKEN", problems);
  if (token && !/^\d+:[\w-]{30,}$/.test(token)) {
    problems.push({
      name: "TELEGRAM_BOT_TOKEN",
      reason: "doesn't look like a BotFather token (expected 123456:ABC-...)",
    });
  }
  // Telegram refuses to open a Mini App over anything but https.
  requireHttpsUrl("MINIAPP_URL", problems);

  // Network — the values most likely to be wrong, and worst when they are.
  requireHttpsUrl("ARC_RPC_URL", problems, true);
  const chainId = requireVar("ARC_CHAIN_ID", problems);
  if (chainId && !/^\d+$/.test(chainId)) {
    problems.push({ name: "ARC_CHAIN_ID", reason: `"${chainId}" is not a number` });
  }

  // Tokens and Onyx contracts
  for (const name of [
    "USDC_ADDRESS",
    "EURC_ADDRESS",
    "ONYX_ROUTER",
    "ONYX_ORDERBOOK",
    "ONYX_QUOTER",
    "ONYX_STABLESWAP",
    "ONYX_TWAP",
  ]) {
    requireAddress(name, problems);
  }

  // CCTP
  for (const name of ["CCTP_TOKEN_MESSENGER", "CCTP_MESSAGE_TRANSMITTER"]) {
    requireAddress(name, problems);
  }
  const domain = process.env.CCTP_ARC_DOMAIN;
  if (domain !== undefined && !/^\d+$/.test(domain.trim())) {
    problems.push({ name: "CCTP_ARC_DOMAIN", reason: `"${domain}" is not a number` });
  }
  // Domain 7 is Polygon PoS. Setting it here would mint users' deposits on the
  // wrong chain, so it's rejected outright rather than warned about.
  if (domain?.trim() === "7") {
    problems.push({
      name: "CCTP_ARC_DOMAIN",
      reason: "7 is Polygon PoS, not Arc. Arc is 26 — funds would mint on the wrong chain",
    });
  }

  return problems;
}

/**
 * Ask the RPC which chain it is and compare. Catches the case static checks
 * cannot: a perfectly well-formed URL pointing at the wrong network.
 */
export async function validateChain(rpcUrl: string, expectedChainId: number): Promise<Problem[]> {
  try {
    const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }) });
    const actual = await client.getChainId();
    if (actual !== expectedChainId) {
      return [
        {
          name: "ARC_RPC_URL / ARC_CHAIN_ID",
          reason:
            `the RPC reports chain ${actual}, but ARC_CHAIN_ID is ${expectedChainId}. ` +
            `One of them is wrong — transactions would go to the wrong network`,
        },
      ];
    }
    return [];
  } catch (e) {
    return [
      {
        name: "ARC_RPC_URL",
        reason: `couldn't reach the RPC to confirm the chain (${e instanceof Error ? e.message.slice(0, 80) : "unknown"})`,
      },
    ];
  }
}

/** Print and exit. Called before anything connects to Telegram. */
export async function assertConfigOrExit() {
  const problems = validateStatic();

  if (problems.length === 0) {
    const rpc = process.env.ARC_RPC_URL!;
    const chainId = Number(process.env.ARC_CHAIN_ID);
    problems.push(...(await validateChain(rpc, chainId)));
  }

  if (problems.length === 0) {
    console.log("[config] validated — network, contracts and Telegram config all look sane");
    return;
  }

  console.error("\n✗ FlowBot will not start — configuration problems:\n");
  for (const p of problems) {
    console.error(`  • ${p.name}: ${p.reason}`);
  }
  console.error(
    "\nFix these in .env and start again.\n" +
      "Network values must be verified against docs.arc.network — a wrong RPC or\n" +
      "chain ID doesn't fail, it succeeds on the wrong chain.\n",
  );
  process.exit(1);
}
