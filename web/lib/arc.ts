import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

export const ADDR = {
  usdc: "0x3600000000000000000000000000000000000000",
  eurc: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
  rateProvider: "0x5BD82828Ffd74d7d9df5B0266d8F8Dc6f05f6d74",
  pool: "0x3Bf8E6EfF4850D8172c019CeEeA00787928162De",
  book: "0x6E04B607Fe10F2A6005d9A843A866129b7274810",
  router: "0x52F9Df11DAE5Af839c28216e2d4f8ab678219312",
  quoter: "0xf2346e79Ab9D92c5e6B5D949331F186a5e040461",
  twap: "0x1081ea6642F8f67dc1ff8A40b8A60900c0180dBE",
} as const;

/** price = tick * TICK_SIZE, TICK_SIZE = 1e13, both tokens are 6dp */
export const TICK_SIZE = 10n ** 13n;
export const UNIT = 1_000_000n; // 1e6

export const tickToPrice = (tick: number) => (tick * 1e13) / 1e18;
export const priceToTick = (p: number) => Math.round((p * 1e18) / 1e13);

export const fmt = (v: bigint | undefined, dp = 4) =>
  v === undefined ? "—" : (Number(v) / 1e6).toFixed(dp);

export const parseUnits6 = (s: string) => {
  const n = Number(s);
  if (!isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.round(n * 1e6));
};
