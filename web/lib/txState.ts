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
  [/0xec30f4ab|StaleRate/i, "FX rate is stale — swaps are paused until the next update."],
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
