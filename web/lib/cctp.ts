/**
 * CCTP V2 constants — VERIFIED, do not edit from memory.
 *
 * Sources (all cross-checked, all agree):
 *  - Arc docs: https://docs.arc.io/arc/references/contract-addresses
 *  - Circle blog (Monad CCTP V2 launch) — same testnet addresses
 *  - Circle blog (Codex CCTP V2 launch)  — same testnet addresses
 *
 * On TESTNET, CCTP V2 is deployed at the same deterministic CREATE2 addresses
 * on every EVM chain, which is why one constant covers Arc and all
 * destinations. Mainnet addresses DIFFER — do not reuse these there.
 *
 * DOMAIN IDS ARE NOT CHAIN IDS. A wrong domain mints the user's USDC on the
 * wrong chain. Arc is 26. A widely-shared blog post claiming Arc is domain 7
 * is WRONG (7 is Polygon PoS). Verified against Arc's own docs.
 */

export const CCTP = {
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
} as const;

export const ARC_DOMAIN = 26;

/** Destination chains we support burning to, with their CCTP domain. */
export const DESTINATIONS = [
  { key: "base", label: "Base Sepolia", domain: 6, chainId: 84532 },
  { key: "ethereum", label: "Ethereum Sepolia", domain: 0, chainId: 11155111 },
  { key: "arbitrum", label: "Arbitrum Sepolia", domain: 3, chainId: 421614 },
] as const;

export type Destination = (typeof DESTINATIONS)[number];

/** Standard (not Fast) transfer: no fee, wait for hard finality. */
export const STANDARD_MAX_FEE = 0n;
export const STANDARD_FINALITY_THRESHOLD = 2000;

export const tokenMessengerAbi = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

export const messageTransmitterAbi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** left-pad a 20-byte address into the bytes32 CCTP expects */
export const toBytes32 = (addr: string) =>
  `0x${"0".repeat(24)}${addr.replace(/^0x/, "").toLowerCase()}` as `0x${string}`;

export type PendingTransfer = {
  burnTx: string;
  amount: string;
  destKey: string;
  destDomain: number;
  destChainId: number;
  destLabel: string;
  createdAt: number;
  message?: string;
  attestation?: string;
  claimTx?: string;
};
