/**
 * Minimal ABIs for the Onyx contracts on Arc. Only the functions FlowBot calls
 * are included — a smaller surface is easier to audit and keeps bundle size
 * down in the Mini App.
 */

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/**
 * Quoter.quote() is a view-only ternary search for the optimal split between
 * the order book and the StableSwap curve. `bookIn` is how much of the input
 * should sweep the book; the remainder goes to the curve.
 */
export const quoterAbi = [
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      { name: "zeroForOne", type: "bool" },
      { name: "amountIn", type: "uint256" },
      { name: "iters", type: "uint16" },
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
      { name: "bookIn", type: "uint256" },
      { name: "minOut", type: "uint256" },
      { name: "limitTick", type: "uint32" },
      { name: "maxFills", type: "uint16" },
      { name: "deadline", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

export const orderBookAbi = [
  { type: "function", name: "bestBid", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "bestAsk", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "levelDepth", stateMutability: "view", inputs: [{ type: "bool" }, { type: "uint32" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "placeOrder", stateMutability: "nonpayable", inputs: [{ type: "bool" }, { type: "uint32" }, { type: "uint128" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "cancelOrder", stateMutability: "nonpayable", inputs: [{ type: "uint64" }], outputs: [] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  {
    type: "function",
    name: "orders",
    stateMutability: "view",
    inputs: [{ type: "uint64" }],
    outputs: [
      { name: "maker", type: "address" },
      { name: "tick", type: "uint32" },
      { name: "isBid", type: "bool" },
      { name: "active", type: "bool" },
      { name: "baseAmount", type: "uint128" },
      { name: "baseFilled", type: "uint128" },
      { name: "quoteEscrow", type: "uint256" },
      { name: "prev", type: "uint64" },
      { name: "next", type: "uint64" },
    ],
  },
] as const;

export const twapAbi = [
  {
    type: "function",
    name: "createTwap",
    stateMutability: "nonpayable",
    inputs: [
      { name: "zeroForOne", type: "bool" },
      { name: "totalAmount", type: "uint128" },
      { name: "slices", type: "uint32" },
      { name: "interval", type: "uint32" },
      { name: "minPriceX18", type: "uint192" },
    ],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "cancelTwap", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

export const stableSwapAbi = [
  { type: "function", name: "getDy", stateMutability: "view", inputs: [{ type: "bool" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balance0", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balance1", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
