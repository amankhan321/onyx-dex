export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export const poolAbi = [
  { type: "function", name: "balance0", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balance1", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getVirtualPrice", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getDy", stateMutability: "view", inputs: [{ name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "addLiquidity", stateMutability: "nonpayable", inputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

export const bookAbi = [
  { type: "function", name: "bestBid", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "bestAsk", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "levelDepth", stateMutability: "view", inputs: [{ name: "isBid", type: "bool" }, { name: "tick", type: "uint32" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "nextBidBelow", stateMutability: "view", inputs: [{ name: "tick", type: "uint32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "nextAskAbove", stateMutability: "view", inputs: [{ name: "tick", type: "uint32" }], outputs: [{ type: "uint32" }] },
  { type: "function", name: "claimableBase", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimableQuote", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "placeOrder", stateMutability: "nonpayable", inputs: [{ name: "isBid", type: "bool" }, { name: "tick", type: "uint32" }, { name: "baseAmount", type: "uint128" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "cancelOrder", stateMutability: "nonpayable", inputs: [{ type: "uint64" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "flushFees", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

export const quoterAbi = [
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint256" },
      { name: "maxLevels", type: "uint16" },
    ],
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
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint256" },
      { name: "bookAmountIn", type: "uint256" },
      { name: "minAmountOut", type: "uint256" },
      { name: "limitTick", type: "uint32" },
      { name: "maxOrders", type: "uint16" },
      { name: "deadline", type: "uint256" },
      { name: "to", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;
