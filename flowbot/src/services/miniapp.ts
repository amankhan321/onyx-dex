/**
 * Building the hand-off to the Mini App.
 *
 * The bot never signs. When a user confirms a trade, we encode the UNSIGNED
 * transaction into the Mini App URL; the user's device does the rest. The
 * payload is not secret — it is exactly what the user is consenting to — so
 * putting it in the URL is fine, and it keeps the server stateless.
 */
import type { UnsignedTx } from "../contracts/onyx";

export function encodeTx(tx: UnsignedTx): string {
  const json = JSON.stringify({
    to: tx.to,
    data: tx.data,
    value: tx.value.toString(),
    chainId: tx.chainId,
    summary: tx.summary,
  });
  return Buffer.from(json, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function miniAppUrl(base: string, tx?: UnsignedTx): string {
  if (!tx) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}tx=${encodeTx(tx)}`;
}
