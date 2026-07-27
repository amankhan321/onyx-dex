/**
 * Withdrawals — validation, gas estimation, and unsigned transfer construction.
 *
 * Same contract as the trading module: pure, framework-agnostic, and incapable
 * of signing. The bot builds and previews; the Mini App signs on the user's
 * device. Nothing here ever sees a key or a password.
 */

import { encodeFunctionData, getAddress, isAddress, type Address, type PublicClient } from "viem";
import { erc20Abi } from "./abis";
import { fmtUnits, type UnsignedTx } from "./onyx";

const ZERO = "0x0000000000000000000000000000000000000000";

export type TransferCtx = {
  client: PublicClient;
  chainId: number;
  decimals: number;
  tokens: { usdc: Address; eurc: Address };
};

export type ParsedWithdraw = {
  to: Address;
  amount: bigint;
  token: "USDC" | "EURC";
};

/**
 * Parse "0xabc… 25" or "0xabc… 25 EURC" from a chat message.
 *
 * Everything is validated here rather than at the call site, so no handler can
 * skip a check. A malformed address is the one mistake in this flow that cannot
 * be undone, so it is rejected loudly rather than coerced.
 */
export function parseWithdraw(input: string, decimals: number): ParsedWithdraw {
  const cleaned = input.trim().replace(/\s+/g, " ");
  const parts = cleaned.split(" ");

  if (parts.length < 2) {
    throw new Error("Send it as: address amount — for example `0xabc… 25`");
  }

  const [rawAddr, rawAmount, rawToken] = parts;

  if (!isAddress(rawAddr)) {
    throw new Error("That doesn't look like a valid address. It should start with 0x and be 42 characters.");
  }
  // getAddress throws on a bad checksum, which catches a mistyped character
  // that would otherwise send funds into a black hole.
  let to: Address;
  try {
    to = getAddress(rawAddr);
  } catch {
    throw new Error("That address has an invalid checksum — please re-copy it and try again.");
  }
  if (to.toLowerCase() === ZERO) {
    throw new Error("That's the zero address. Funds sent there are destroyed permanently.");
  }

  const n = Number(rawAmount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("The amount must be a positive number.");
  }
  // Guard against precision loss before it becomes a wrong on-chain value.
  const scaled = n * 10 ** decimals;
  if (!Number.isSafeInteger(Math.round(scaled))) {
    throw new Error("That amount is too large to process precisely.");
  }

  const token = (rawToken ?? "USDC").toUpperCase();
  if (token !== "USDC" && token !== "EURC") {
    throw new Error("Token must be USDC or EURC.");
  }

  return { to, amount: BigInt(Math.round(scaled)), token };
}

/** Balance of the token being withdrawn. */
export async function balanceOf(ctx: TransferCtx, owner: Address, token: "USDC" | "EURC"): Promise<bigint> {
  const address = token === "USDC" ? ctx.tokens.usdc : ctx.tokens.eurc;
  return (await ctx.client.readContract({
    address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

/**
 * Estimated fee, denominated in USDC because that is Arc's gas token.
 *
 * NOTE ON DECIMALS: the native gas balance is 18-dec while the USDC ERC-20
 * interface is 6-dec. Gas maths happens in native 18-dec units and is only
 * converted for display — mixing the two is the single easiest way to be wrong
 * by a factor of a trillion on this chain.
 */
export async function estimateFeeUsdc(
  ctx: TransferCtx,
  from: Address,
  tx: { to: Address; data: `0x${string}` },
): Promise<{ wei: bigint; display: string }> {
  try {
    const [gas, gasPrice] = await Promise.all([
      ctx.client.estimateGas({ account: from, to: tx.to, data: tx.data }),
      ctx.client.getGasPrice(),
    ]);
    const wei = gas * gasPrice;
    const usdc = Number(wei) / 1e18; // native is 18-dec
    return { wei, display: usdc < 0.0001 ? "<0.0001" : usdc.toFixed(4) };
  } catch {
    // A failed estimate must not block the preview; say so honestly.
    return { wei: 0n, display: "~0.01" };
  }
}

/** Unsigned ERC-20 transfer. Inert until the Mini App signs it. */
export function buildTransfer(ctx: TransferCtx, p: ParsedWithdraw): UnsignedTx {
  const token = p.token === "USDC" ? ctx.tokens.usdc : ctx.tokens.eurc;
  return {
    to: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [p.to, p.amount] }),
    value: 0n,
    chainId: ctx.chainId,
    summary: `Send ${fmtUnits(p.amount, ctx.decimals)} ${p.token} to ${p.to}`,
    // Explicit amount for the Mini App's fallback-storage cap. Parsing this out
    // of the human summary would be fragile; carrying it as a number is not.
    capValue: Number(p.amount) / 10 ** ctx.decimals,
  };
}

/**
 * Full pre-flight: parse, check the balance, build, estimate the fee. Throws a
 * user-readable message on any failure — nothing here leaks internals.
 */
export async function planWithdraw(
  ctx: TransferCtx,
  owner: Address,
  input: string,
): Promise<{ tx: UnsignedTx; parsed: ParsedWithdraw; fee: string; balance: bigint }> {
  const parsed = parseWithdraw(input, ctx.decimals);

  let balance: bigint;
  try {
    balance = await balanceOf(ctx, owner, parsed.token);
  } catch {
    throw new Error("Couldn't read your balance just now — please try again in a moment.");
  }

  if (parsed.amount > balance) {
    throw new Error(
      `You have ${fmtUnits(balance, ctx.decimals)} ${parsed.token}, which is less than ${fmtUnits(parsed.amount, ctx.decimals)}.`,
    );
  }

  // Sending the entire USDC balance leaves nothing to pay gas with on Arc.
  if (parsed.token === "USDC" && parsed.amount === balance) {
    throw new Error(
      "That's your whole USDC balance, and USDC pays for gas on Arc — leave a little behind so the transaction can be sent.",
    );
  }

  const tx = buildTransfer(ctx, parsed);
  const { display } = await estimateFeeUsdc(ctx, owner, { to: tx.to, data: tx.data });
  return { tx, parsed, fee: display, balance };
}
