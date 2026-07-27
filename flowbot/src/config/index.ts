/**
 * Environment configuration. Everything network- or contract-related is read
 * from .env so nothing has to be recompiled to point at a different deployment.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, fallback?: number): number {
  const v = process.env[name];
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`Missing required env var: ${name}`);
    return fallback;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number`);
  return n;
}

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    miniAppUrl: process.env.MINIAPP_URL ?? "",
  },

  arc: {
    rpcUrl: process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network",
    chainId: num("ARC_CHAIN_ID", 5042002),
    explorer: process.env.ARC_EXPLORER ?? "https://testnet.arcscan.app",
  },

  tokens: {
    usdc: (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as `0x${string}`,
    eurc: (process.env.EURC_ADDRESS ?? "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a") as `0x${string}`,
    /**
     * Arc's native USDC gas balance is 18-dec while the ERC-20 interface is
     * 6-dec. All trading amounts in this codebase are 6-dec ERC-20 units;
     * only gas estimation should ever look at the native balance.
     */
    decimals: 6,
  },

  onyx: {
    router: (process.env.ONYX_ROUTER ?? "") as `0x${string}`,
    orderBook: (process.env.ONYX_ORDERBOOK ?? "") as `0x${string}`,
    quoter: (process.env.ONYX_QUOTER ?? "") as `0x${string}`,
    stableSwap: (process.env.ONYX_STABLESWAP ?? "") as `0x${string}`,
    twap: (process.env.ONYX_TWAP ?? "") as `0x${string}`,
  },

  cctp: {
    tokenMessenger: (process.env.CCTP_TOKEN_MESSENGER ?? "") as `0x${string}`,
    messageTransmitter: (process.env.CCTP_MESSAGE_TRANSMITTER ?? "") as `0x${string}`,
    /**
     * ⚠️ ARC'S CCTP DOMAIN — CONFIGURABLE ON PURPOSE, VERIFY BEFORE SHIPPING.
     *
     * A domain id is NOT a chain id. Send a burn to the wrong domain and the
     * user's USDC mints on a different chain — unrecoverable by us.
     *
     * Arc's docs give 26. A widely-shared blog post claims 7, which is Polygon
     * PoS and would silently misroute funds. Confirm against Circle's official
     * docs for the deployment you are targeting before enabling withdrawals,
     * and never "fix" this value from memory.
     */
    arcDomain: num("CCTP_ARC_DOMAIN", 26),
    irisUrl: process.env.CCTP_IRIS_URL ?? "https://iris-api-sandbox.circle.com",
  },

  storage: {
    databaseUrl: process.env.DATABASE_URL ?? "file:./flowbot.db",
    redisUrl: process.env.REDIS_URL ?? "",
  },

  limits: {
    maxSlippageBps: num("MAX_SLIPPAGE_BPS", 300),
    highImpactWarnBps: num("HIGH_IMPACT_WARN_BPS", 100),
    rateLimitPerMin: num("RATE_LIMIT_PER_MIN", 20),
  },
} as const;

export { req };
