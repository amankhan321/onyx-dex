/**
 * Drift check: does .env.example still match the live Onyx deployment?
 *
 * The bot and the DEX must talk to the same contracts on the same chain. If they
 * diverge, the bot quotes one deployment while the site shows another — and
 * nothing errors, so nobody notices until a trade behaves strangely. This makes
 * that drift a build failure instead.
 */
import { readFileSync } from "node:fs";

const contracts = readFileSync(new URL("../../web/lib/contracts.ts", import.meta.url), "utf8");
const cctpSrc = readFileSync(new URL("../../web/lib/cctp.ts", import.meta.url), "utf8");
const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");

const pick = (re, src, label) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not read ${label} from the live app config`);
  return m[1];
};

const addrBlock = pick(/export const ADDR = \{(.*?)\} as const;/s, contracts, "ADDR");
const addr = Object.fromEntries(
  [...addrBlock.matchAll(/(\w+):\s*"(0x[0-9a-fA-F]{40})"/g)].map((m) => [m[1], m[2]]),
);
const cctp = Object.fromEntries(
  [...cctpSrc.matchAll(/(\w+):\s*"(0x[0-9a-fA-F]{40})"/g)].map((m) => [m[1], m[2]]),
);

const expected = {
  ARC_RPC_URL: pick(/http:\s*\["([^"]+)"\]/, contracts, "rpc url"),
  ARC_CHAIN_ID: pick(/id:\s*(\d+)/, contracts, "chain id"),
  USDC_ADDRESS: addr.usdc,
  EURC_ADDRESS: addr.eurc,
  ONYX_ROUTER: addr.router,
  ONYX_ORDERBOOK: addr.book,
  ONYX_QUOTER: addr.quoter,
  ONYX_STABLESWAP: addr.pool,
  ONYX_TWAP: addr.twap,
  CCTP_TOKEN_MESSENGER: cctp.tokenMessenger,
  CCTP_MESSAGE_TRANSMITTER: cctp.messageTransmitter,
};

const actual = Object.fromEntries(
  env
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).trim()];
    }),
);

const problems = [];
for (const [key, want] of Object.entries(expected)) {
  const got = actual[key];
  if (!got) problems.push(`${key}: missing from .env.example`);
  else if (got.toLowerCase() !== String(want).toLowerCase()) {
    problems.push(`${key}\n      .env.example: ${got}\n      live app:     ${want}`);
  }
}

if (actual.CCTP_ARC_DOMAIN !== "26") {
  problems.push(`CCTP_ARC_DOMAIN is "${actual.CCTP_ARC_DOMAIN}" — Arc is 26 (7 is Polygon PoS)`);
}

if (problems.length) {
  console.error("\n✗ .env.example has drifted from the live Onyx deployment:\n");
  for (const p of problems) console.error(`  • ${p}`);
  console.error("\nThe bot and the DEX must point at the same contracts.\n");
  process.exit(1);
}

console.log(
  `✓ .env.example matches the live Onyx deployment (chain ${expected.ARC_CHAIN_ID}, ${Object.keys(expected).length} values checked)`,
);
