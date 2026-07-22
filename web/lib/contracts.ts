import { defineChain } from "viem";

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { decimals: 18, name: "USDC", symbol: "USDC" },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
  // Standard Multicall3 (same address on every chain). Lets viem fold the four
  // pool reads into ONE eth_call instead of four serial round-trips through the
  // proxy — the cause of the 10-15s stat-card lag.
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
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

/** price = tick * TICK_SIZE, where TICK_SIZE = 1e13 in 1e18 fixed point. */
export const TICK_SIZE = 1e-5;
export const DECIMALS = 6;

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export const poolAbi = [
  { type: "function", name: "balance0", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balance1", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getVirtualPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getDy", stateMutability: "view", inputs: [{ type: "bool" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const bookAbi = [
  { type: "function", name: "bestBid", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "bestAsk", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "levelDepth", stateMutability: "view", inputs: [{ type: "bool" }, { type: "uint32" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "nextBidBelow", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "nextAskAbove", stateMutability: "view", inputs: [{ type: "uint32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "claimableBase", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimableQuote", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "takerFeeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "placeOrder", stateMutability: "nonpayable", inputs: [{ type: "bool" }, { type: "uint32" }, { type: "uint128" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "cancelOrder", stateMutability: "nonpayable", inputs: [{ type: "uint64" }], outputs: [] },
  { type: "function", name: "orders", stateMutability: "view", inputs: [{ type: "uint64" }], outputs: [
    { name: "maker", type: "address" }, { name: "tick", type: "uint32" }, { name: "isBid", type: "bool" },
    { name: "active", type: "bool" }, { name: "baseAmount", type: "uint128" }, { name: "baseFilled", type: "uint128" },
    { name: "quoteEscrow", type: "uint256" }, { name: "prev", type: "uint64" }, { name: "next", type: "uint64" },
  ] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "flushFees", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

export const quoterAbi = [
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [{ type: "bool" }, { type: "uint256" }, { type: "uint16" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "bookIn", type: "uint256" },
          { name: "ammIn", type: "uint256" },
          { name: "expectedOut", type: "uint256" },
          { name: "bookOut", type: "uint256" },
          { name: "ammOut", type: "uint256" },
          { name: "limitTick", type: "uint32" },
        ],
      },
    ],
  },
] as const;

export const routerAbi = [
  {
    type: "function",
    name: "swapExactIn",
    stateMutability: "nonpayable",
    inputs: [
      { type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint32" }, { type: "uint16" }, { type: "uint256" }, { type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const twapReadAbi = [
  { type: "function", name: "nextTwapId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "twaps", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [
    { name: "owner", type: "address" }, { name: "zeroForOne", type: "bool" }, { name: "active", type: "bool" },
    { name: "interval", type: "uint32" }, { name: "slicesLeft", type: "uint32" }, { name: "sliceAmount", type: "uint128" },
    { name: "remaining", type: "uint128" }, { name: "nextExecAt", type: "uint64" }, { name: "minPriceX18", type: "uint192" },
  ]},
] as const;

export const twapAbi = [
  { type: "function", name: "cancelTwap", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "createTwap",
    stateMutability: "nonpayable",
    inputs: [{ type: "bool" }, { type: "uint128" }, { type: "uint32" }, { type: "uint32" }, { type: "uint192" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const fmt = (v: bigint, dp = 4) =>
  (Number(v) / 10 ** DECIMALS).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });

export const parse = (s: string): bigint => {
  const n = Number(s);
  if (!isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.floor(n * 10 ** DECIMALS));
};

export const priceOf = (tick: number) => tick * TICK_SIZE;
export const tickOf = (price: number) => Math.round(price / TICK_SIZE);
