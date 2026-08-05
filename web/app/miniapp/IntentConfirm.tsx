"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useReadContract } from "wagmi";
import { ADDR, erc20Abi, fmt, parse, quoterAbi } from "@/lib/contracts";
import { useSwapQuote } from "@/lib/useSwapQuote";
import { buildApprove, buildSwap } from "@/lib/onyxActions";
import { useSigner } from "@/lib/signer";
import { initData, startParam, haptic } from "@/lib/telegram";
import { PAIR, describeSwap, formatUnits6 } from "@/lib/bot/quote";
import { REAUTH_THRESHOLD } from "./MiniApp";
import type { TradePayload } from "@/lib/bot/commands";

/**
 * The receiving half of a chat-initiated trade.
 *
 * A signing command in chat stores an intent and deep-links here with an opaque
 * id. This screen exchanges that id — once — for the trade PARAMETERS, then
 * RE-QUOTES AND RE-DERIVES EVERY NUMBER ON THE DEVICE before showing what it is
 * about to sign.
 *
 * Nothing from the link is trusted or displayed. The id carries no amounts and
 * no prices; the parameters come from the server, but the quote, the minimum
 * received, and the transaction itself are all computed here, from the chain,
 * at the moment of signing. A stale or altered intent therefore cannot cause a
 * silently different trade — it can only fail, or produce a fresh quote the user
 * sees before approving.
 *
 * Signing is via signer.writeBatch, the same path as SwapTab: no writeContract
 * in a tab, no server-side key, nothing signed that the user has not just read.
 */

type ConsumeState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; payload: TradePayload }
  | { status: "refused"; message: string; expired: boolean }
  | { status: "error"; message: string };

export function IntentConfirm({ onDone, onDismiss }: { onDone: () => void; onDismiss: () => void }) {
  const [state, setState] = useState<ConsumeState>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);
  const signer = useSigner();
  const { address } = useAccount();
  const client = usePublicClient();

  // Consume exactly once per mount. The id is single-use server-side, so a
  // re-entrant call would burn it and show "already used" on a legitimate open.
  useEffect(() => {
    const id = startParam();
    if (!id) return;
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      try {
        const res = await fetch("/api/telegram/intent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, initData: initData() }),
        });
        const json = (await res.json()) as
          | { ok: true; payload: TradePayload }
          | { ok: false; message?: string; expired?: boolean; error?: string };
        if (cancelled) return;
        if (json.ok) {
          setState({ status: "ready", payload: json.payload });
        } else if (json.message) {
          setState({ status: "refused", message: json.message, expired: Boolean(json.expired) });
        } else {
          setState({ status: "error", message: "Couldn't open that trade request." });
        }
      } catch {
        if (!cancelled) setState({ status: "error", message: "Couldn't reach the server. Try again." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const payload = state.status === "ready" ? state.payload : null;
  const isSwap = payload?.command === "buy" || payload?.command === "sell";
  const zeroForOne = payload?.command === "buy";
  const amountIn = isSwap && payload && "amount" in payload ? parse(payload.amount) : 0n;

  // THE RE-QUOTE. Same hook the Swap tab uses, so chat and app cannot diverge,
  // and the figure shown is read from the chain here — never from the link.
  const { quote, error: quoteError } = useSwapQuote(zeroForOne, isSwap ? amountIn : 0n);

  const tokenIn = zeroForOne ? (ADDR.usdc as `0x${string}`) : (ADDR.eurc as `0x${string}`);
  const { data: allowance } = useReadContract({
    address: tokenIn,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, ADDR.router as `0x${string}`] : undefined,
    query: { enabled: Boolean(address) && isSwap },
  });

  const sign = useCallback(async () => {
    if (!payload || !address || !client || !quote) return;
    setBusy(true);
    setTxError(null);
    try {
      const slippageBps = "slippageBps" in payload ? payload.slippageBps : 50;
      const reqs = [];

      if ((allowance ?? 0n) < amountIn) {
        reqs.push({
          ...buildApprove(tokenIn, ADDR.router as `0x${string}`, amountIn),
          label: "Approve",
        });
      }

      // RE-QUOTE AT THE MOMENT OF SIGNING, not at render. The on-screen quote
      // can be seconds old, and limitTick/bookIn are only valid against the book
      // they were computed from. Same guard as SwapTab, for the same reason.
      const fresh = (await client.readContract({
        address: ADDR.quoter as `0x${string}`,
        abi: quoterAbi,
        functionName: "quote",
        args: [zeroForOne, amountIn, 16],
      })) as { bookIn: bigint; expectedOut: bigint; limitTick: number };

      if (fresh.expectedOut === 0n) {
        throw new Error("No route available right now — the curve may be paused on a stale rate.");
      }
      // Never silently re-price: if it moved under the user, stop and say so.
      const drop = Number(((quote.expectedOut - fresh.expectedOut) * 10_000n) / quote.expectedOut);
      if (drop > 100) {
        throw new Error(
          `Price moved ${(drop / 100).toFixed(2)}% since that quote. Check the new figure and tap again.`,
        );
      }

      reqs.push({
        ...buildSwap({
          zeroForOne,
          amountIn,
          bookIn: fresh.bookIn,
          expectedOut: fresh.expectedOut,
          limitTick: Number(fresh.limitTick),
          recipient: address,
          slippageBps,
        }),
        label: "Submit swap",
        capValue: Number(fmt(amountIn)),
        // A withdrawal always re-prompts, and so does anything over the
        // threshold — session state does not exempt either.
        requiresReauth:
          payload.command === "withdraw" || Number(fmt(amountIn)) > REAUTH_THRESHOLD,
      });

      await signer.writeBatch(reqs);
      haptic.success();
      onDone();
    } catch (e) {
      haptic.error();
      setTxError(e instanceof Error ? e.message.slice(0, 160) : "Transaction failed.");
    } finally {
      setBusy(false);
    }
  }, [payload, address, client, quote, allowance, amountIn, tokenIn, zeroForOne, signer, onDone]);

  if (state.status === "idle") return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 sm:items-center">
      <div className="w-full max-w-md rounded-[16px] border border-line bg-bg p-4">
        <h2 className="text-sm font-medium text-fg">Confirm trade · {PAIR}</h2>

        {state.status === "loading" && (
          <p className="mt-3 text-[13px] text-muted">Opening your trade request…</p>
        )}

        {state.status === "refused" && (
          <>
            <p className="mt-3 text-[13px] leading-relaxed text-yellow-500/90">{state.message}</p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={onDismiss}
                className="flex-1 rounded-[10px] border border-line px-3 py-2 text-[13px] text-fg"
              >
                {state.expired ? "Get a fresh quote" : "Close"}
              </button>
            </div>
            {state.expired && (
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                Prices move — we never re-price a request behind your back. Send the command
                again in chat for a new one.
              </p>
            )}
          </>
        )}

        {state.status === "error" && (
          <>
            <p className="mt-3 text-[13px] text-rose">{state.message}</p>
            <button
              onClick={onDismiss}
              className="mt-4 w-full rounded-[10px] border border-line px-3 py-2 text-[13px] text-fg"
            >
              Close
            </button>
          </>
        )}

        {state.status === "ready" && payload && (
          <>
            {isSwap && (
              <>
                {/* Re-derived here, from a chain read — not from the link. */}
                <p className="mt-3 text-[13px] leading-relaxed text-fg">
                  {quote
                    ? describeSwap(zeroForOne, amountIn, quote.expectedOut)
                    : quoteError
                      ? "Couldn't get a fresh quote."
                      : "Getting a fresh quote…"}
                </p>
                {quote && (
                  <dl className="mt-3 space-y-1 text-[12px] text-muted">
                    <div className="flex justify-between">
                      <dt>You pay</dt>
                      <dd className="text-fg">
                        {formatUnits6(amountIn)} {zeroForOne ? "USDC" : "EURC"}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>You receive</dt>
                      {/* Verbatim from the quoter — both fees are already inside it. */}
                      <dd className="text-fg">
                        ~{formatUnits6(quote.expectedOut)} {zeroForOne ? "EURC" : "USDC"}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Fee</dt>
                      <dd>already in the quote</dd>
                    </div>
                  </dl>
                )}
              </>
            )}

            {!isSwap && (
              <p className="mt-3 text-[13px] leading-relaxed text-muted">
                {payload.command} requests open in their own tab for now — this screen handles
                market swaps.
              </p>
            )}

            {txError && <p className="mt-3 text-[12px] text-rose">{txError}</p>}

            <div className="mt-4 flex gap-2">
              <button
                onClick={onDismiss}
                disabled={busy}
                className="flex-1 rounded-[10px] border border-line px-3 py-2 text-[13px] text-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={sign}
                disabled={busy || !quote || !isSwap || !signer.ready}
                className="flex-1 rounded-[10px] bg-fg px-3 py-2 text-[13px] font-medium text-bg disabled:opacity-50"
              >
                {busy ? "Signing…" : "Sign"}
              </button>
            </div>

            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              Quoted fresh on this device just now. Your key never leaves it.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
