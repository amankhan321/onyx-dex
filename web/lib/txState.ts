/**
 * Transaction lifecycle and human error text.
 *
 * Two problems this replaces:
 *
 *  1. A success banner that never cleared. onResult set a hash and nothing ever
 *     unset it, so a green "Sent" sat above a red failure from the next attempt.
 *     Modelling this as one state means exactly one banner can be true.
 *  2. Raw viem strings shown to users. "HTTP request failed." describes a
 *     transport detail; it tells someone trying to trade nothing about what to
 *     do. The technical text is kept, just moved behind a toggle.
 *
 * "Sent" is also not a finished state — a broadcast transaction can still
 * revert, so the machine continues to pending and only then confirmed/failed.
 */

export type TxState =
  | { status: "idle" }
  | { status: "signing" }
  | { status: "broadcasting" }
  | { status: "pending"; hash: string }
  | { status: "confirmed"; hash: string }
  | { status: "failed"; message: string; detail?: string; hash?: string };

export const txIdle: TxState = { status: "idle" };

/** True while the user should not be able to submit again. */
export const isBusy = (s: TxState) =>
  s.status === "signing" || s.status === "broadcasting" || s.status === "pending";

/** Exactly one banner. Success and failure can never both be showing. */
export function banner(s: TxState):
  | { kind: "none" }
  | { kind: "progress"; text: string }
  | { kind: "success"; text: string; hash: string }
  | { kind: "error"; text: string; detail?: string } {
  switch (s.status) {
    case "idle":
      return { kind: "none" };
    case "signing":
      return { kind: "progress", text: "Waiting for your confirmation…" };
    case "broadcasting":
      return { kind: "progress", text: "Sending to Arc…" };
    case "pending":
      return { kind: "progress", text: "Submitted — waiting for confirmation…" };
    case "confirmed":
      return { kind: "success", text: "Confirmed", hash: s.hash };
    case "failed":
      return { kind: "error", text: s.message, detail: s.detail };
  }
}

/** Custom errors the contracts revert with, in language a trader can act on. */
const REVERTS: [RegExp, string][] = [
  // StaleRate reaches here from a swap (StableSwap :110, :126) OR from
  // addLiquidity (:200), so "swaps are paused" alone misreads an LP failure.
  // removeLiquidity is proportional and oracle-free (:262), so withdrawals are
  // unaffected, as are all order-book actions.
  [/0xec30f4ab|StaleRate/i, "The FX rate feed is stale — AMM swaps and adding liquidity are paused until the next update. Order-book actions and LP withdrawals are unaffected."],
  [/WouldCross/i, "That price would cross the spread. Post-only orders must rest on the book."],
  [/TooSoon/i, "The rate was updated moments ago — try again shortly."],
  [/DeviationTooLarge/i, "That price move is larger than the oracle allows in one step."],
  [/Slippage|minOut|InsufficientOutput/i, "Price moved more than your slippage allows. Try again."],
  [/Deadline|expired/i, "The quote expired. Get a fresh one and retry."],
];

/**
 * Map a thrown error to something worth reading, keeping the original for the
 * Details toggle. Order matters: user rejection is checked before transport,
 * because a wallet rejection can carry a network-ish message.
 */
export function friendlyError(err: unknown): { message: string; detail?: string } {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const detail = raw.split("\n")[0].slice(0, 300) || undefined;
  const s = raw.toLowerCase();

  if (/user rejected|user denied|rejected the request|cancell?ed/.test(s)) {
    return { message: "Cancelled." };
  }
  if (/wrong password|corrupted keystore/.test(s)) {
    return { message: "Wrong password.", detail };
  }
  for (const [re, msg] of REVERTS) {
    if (re.test(raw)) return { message: msg, detail };
  }
  if (/insufficient funds|exceeds balance|insufficient balance/.test(s)) {
    return { message: "Not enough USDC for this swap plus gas.", detail };
  }
  if (/\b403\b|\b429\b|http request failed|fetch failed|network|timeout|upstream|econn/.test(s)) {
    return {
      message: "Couldn't reach the Arc network. Check your connection and try again.",
      detail,
    };
  }
  if (/nonce/.test(s)) {
    return { message: "Transaction conflict — please try again.", detail };
  }
  return { message: "Swap failed.", detail };
}


/**
 * A named stage of a swap, so a failure says WHERE it happened.
 *
 * "Swap failed." is unactionable — it cannot distinguish a rejected password
 * from a missing allowance from an on-chain revert, and those need completely
 * different responses from the user.
 */
export type SwapStepState = "pending" | "active" | "done" | "failed";

/**
 * A swap has two steps the user can act on.
 *
 * Unlock is not one: inside a live session it is instant and says nothing, and
 * when a password IS needed the prompt is itself the feedback. A row that is
 * either invisible or redundant is noise.
 *
 * Approve is a real transaction and stays in the record — but it is part of
 * submitting, not a separate thing the user does. It folds into step 1, which
 * relabels while the approval is in flight and keeps its hash reachable.
 */
export type SwapStep = {
  id: "submit" | "confirm";
  label: string;
  state: SwapStepState;
  detail?: string;
  hash?: string;
  /** The approval's hash, surfaced on step 1 so the record stays complete. */
  approvalHash?: string;
};

export const initialSwapSteps = (): SwapStep[] => [
  { id: "submit", label: "Submitting swap", state: "pending" },
  { id: "confirm", label: "Confirming on Arc", state: "pending" },
];

export function setStep(
  steps: SwapStep[],
  id: SwapStep["id"],
  patch: Partial<Omit<SwapStep, "id">>,
): SwapStep[] {
  return steps.map((s) => (s.id === id ? { ...s, ...patch } : s));
}

/** Which step to blame when a throw arrives with no step context. */
export function stepForError(err: unknown): SwapStep["id"] {
  const s = String((err as Error)?.message ?? err).toLowerCase();
  // Only a revert of the swap itself belongs to "confirming" — everything
  // before the transaction lands, including a failed approval, is submission.
  if (/reverted on-chain|slippage|wouldcross|stalerate|expired/.test(s)) return "confirm";
  return "submit";
}
