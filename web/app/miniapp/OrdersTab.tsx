"use client";

import { useCallback, useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { ExternalLink } from "lucide-react";
import { ADDR, arcTestnet, bookAbi, fmt, twapAbi, twapReadAbi } from "@/lib/contracts";
import { useSigner } from "@/lib/signer";
import { buildCancelOrder, buildCancelTwap, buildClaim } from "@/lib/onyxActions";
import { haptic } from "@/lib/telegram";
import { useMyOrders } from "@/lib/useMyOrders";
import { filterOwnedActive, relativeTime, type TwapPosition, type TwapTuple } from "@/lib/miniMath";
import { appendTxLog, useMiniPoll } from "@/lib/useMiniPoll";
import { EmptyState, ErrorState, Skeleton, Spinner, arcscan } from "./Panel";
import { formatAge } from "@/lib/rateKeeper";

type OrdersData = {
  claimableBase: bigint;
  claimableQuote: bigint;
  twaps: TwapPosition[];
};

export function OrdersTab({
  onResult,
  onGoSwap,
}: {
  onResult: (hash: string) => void;
  onGoSwap: () => void;
}) {
  const signer = useSigner();
  const client = usePublicClient({ chainId: arcTestnet.id });
  const { orders, remove: removeOrder } = useMyOrders();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [staleAge, setStaleAge] = useState<number | null>(null);

  // Cancelling and claiming touch the order book only — neither reads the FX
  // oracle — so both keep working while swaps are halted. Worth saying, since
  // "trading is paused" otherwise reads as "nothing works".
  useEffect(() => {
    void fetch("/api/status")
      .then((r) => r.json())
      .then((s) => setStaleAge(s?.stale ? s.ageSeconds : null))
      .catch(() => setStaleAge(null));
  }, []);

  const fetcher = useCallback(async (): Promise<OrdersData> => {
    if (!client || !signer.address) throw new Error("Wallet not ready");
    const me = signer.address;

    // View calls only — no getLogs. Log ranges over the mobile RPC proxy have
    // been unreliable, and everything here is readable as plain state.
    const [cBase, cQuote, nextId] = (await client.multicall({
      allowFailure: false,
      contracts: [
        { address: ADDR.book as `0x${string}`, abi: bookAbi, functionName: "claimableBase", args: [me] },
        { address: ADDR.book as `0x${string}`, abi: bookAbi, functionName: "claimableQuote", args: [me] },
        { address: ADDR.twap as `0x${string}`, abi: twapReadAbi, functionName: "nextTwapId" },
      ],
    })) as [bigint, bigint, bigint];

    // Scan a bounded window of recent ids rather than the whole history.
    const last = Number(nextId);
    const ids: bigint[] = [];
    for (let i = Math.max(0, last - 40); i < last; i++) ids.push(BigInt(i));

    let twaps: TwapPosition[] = [];
    if (ids.length > 0) {
      const res = await client.multicall({
        allowFailure: true,
        contracts: ids.map((id) => ({
          address: ADDR.twap as `0x${string}`,
          abi: twapReadAbi,
          functionName: "twaps" as const,
          args: [id],
        })),
      });
      const rows = res
        .map((r, i) => (r.status === "success" ? { id: ids[i], tuple: r.result as unknown as TwapTuple } : null))
        .filter((x): x is { id: bigint; tuple: TwapTuple } => x !== null);
      twaps = filterOwnedActive(rows, me);
    }

    return { claimableBase: cBase, claimableQuote: cQuote, twaps };
  }, [client, signer.address]);

  const { status, data, error, refetch } = useMiniPoll<OrdersData>(fetcher, [signer.address]);

  async function cancelOrder(id: string, size: string) {
    setBusy(id);
    setActionError(null);
    haptic.confirm();
    // Optimistic: pull the row now, restore it if the chain rejects.
    const snapshot = orders.find((o) => o.id === id);
    removeOrder(id);
    try {
      const req = buildCancelOrder(BigInt(id));
      const hash = await signer.write({ ...req, capValue: Number(size) });
      appendTxLog(signer.address!, { hash, kind: "Cancel order", at: Date.now() });
      haptic.success();
      onResult(hash);
      void refetch();
    } catch (e) {
      haptic.error();
      if (snapshot) window.dispatchEvent(new CustomEvent("onyx:restore-order", { detail: snapshot }));
      setActionError(e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "Cancel failed");
    } finally {
      setBusy(null);
    }
  }

  async function claim() {
    if (!data) return;
    setBusy("claim");
    setActionError(null);
    haptic.confirm();
    try {
      const total = Number(data.claimableBase + data.claimableQuote) / 1e6;
      const hash = await signer.write({
        ...buildClaim(),
        capValue: total,
        // Claiming moves funds out of the book and into the wallet, so it gets
        // the same treatment as a withdrawal: always re-prompt, never ride an
        // already-unlocked session.
        requiresReauth: true,
      });
      appendTxLog(signer.address!, { hash, kind: "Claim fills", at: Date.now() });
      haptic.success();
      onResult(hash);
      void refetch();
    } catch (e) {
      haptic.error();
      setActionError(e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "Claim failed");
    } finally {
      setBusy(null);
    }
  }

  async function cancelTwap(id: bigint, remaining: bigint) {
    setBusy(`twap-${id}`);
    setActionError(null);
    haptic.confirm();
    try {
      const hash = await signer.write({
        ...buildCancelTwap(id),
        capValue: Number(remaining) / 1e6,
      });
      appendTxLog(signer.address!, { hash, kind: "Cancel TWAP", at: Date.now() });
      haptic.success();
      onResult(hash);
      void refetch();
    } catch (e) {
      haptic.error();
      setActionError(e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "Cancel failed");
    } finally {
      setBusy(null);
    }
  }

  if (status === "loading" && !data) return <Skeleton rows={3} />;
  if (status === "error" && !data) return <ErrorState message={error!} onRetry={refetch} />;

  const hasClaimable = Boolean(data && (data.claimableBase > 0n || data.claimableQuote > 0n));
  const nothing = orders.length === 0 && !hasClaimable && (data?.twaps.length ?? 0) === 0;

  return (
    <div className="space-y-3">
      {status === "error" && data && (
        <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/[0.08] p-2.5 text-[10px] text-yellow-600">
          Showing last known data — refresh failed.
        </p>
      )}
      {staleAge !== null && (
        <p className="rounded-lg border border-yellow-500/30 bg-yellow-500/[0.08] p-3 text-[11px] leading-relaxed text-yellow-600">
          FX rate stale — last updated {formatAge(staleAge)} ago, so swaps are paused.
          Cancelling and claiming still work normally.
        </p>
      )}
      {actionError && (
        <p className="rounded-lg border border-rose/30 bg-rose/[0.06] p-3 text-[11px] text-rose">
          {actionError}
        </p>
      )}

      {hasClaimable && data && (
        <section className="rounded-xl border border-mint/30 bg-mint/[0.07] p-4">
          <h3 className="text-sm font-medium text-fg">Ready to claim</h3>
          <p className="mt-1 text-[11px] text-faint">
            Filled orders and released escrow, waiting in the book.
          </p>
          <div className="mt-2 flex gap-4 font-mono text-sm tabular text-fg">
            <span>{fmt(data.claimableBase)} USDC</span>
            <span>{fmt(data.claimableQuote)} EURC</span>
          </div>
          <button
            onClick={claim}
            disabled={busy !== null}
            className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full bg-mint text-sm font-semibold text-black disabled:opacity-40"
          >
            {busy === "claim" && <Spinner />}
            {busy === "claim" ? "Claiming…" : "Claim"}
          </button>
        </section>
      )}

      {orders.length > 0 && (
        <section>
          <h3 className="px-1 text-[10px] uppercase tracking-[0.14em] text-faint">Open orders</h3>
          <div className="mt-2 space-y-2">
            {orders.map((o) => (
              <div key={o.id} className="inner p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-fg">{o.side}</span>
                  <a
                    href={arcscan(o.tx)}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 font-mono text-[10px] text-faint"
                  >
                    #{o.id} <ExternalLink size={9} />
                  </a>
                </div>
                <div className="mt-1 font-mono text-[11px] text-faint">
                  {o.size} USDC @ {o.price} EURC
                </div>
                <button
                  onClick={() => cancelOrder(o.id, o.size)}
                  disabled={busy !== null}
                  className="mt-2 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full border border-rose/40 text-xs text-rose disabled:opacity-40"
                >
                  {busy === o.id && <Spinner />}
                  {busy === o.id ? "Cancelling…" : "Cancel"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data && data.twaps.length > 0 && (
        <section>
          <h3 className="px-1 text-[10px] uppercase tracking-[0.14em] text-faint">TWAP positions</h3>
          <div className="mt-2 space-y-2">
            {data.twaps.map((t) => (
              <div key={t.id.toString()} className="inner p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-fg">
                    Sell {t.zeroForOne ? "USDC" : "EURC"}
                  </span>
                  <span className="font-mono text-[10px] text-faint">#{t.id.toString()}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-faint">
                  <span>{fmt(t.remaining)} left</span>
                  <span>{t.slicesLeft} slices</span>
                  <span>every {Math.round(t.interval / 60)}m</span>
                  <span>next {relativeTime(t.nextExecAt)}</span>
                </div>
                <button
                  onClick={() => cancelTwap(t.id, t.remaining)}
                  disabled={busy !== null}
                  className="mt-2 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full border border-rose/40 text-xs text-rose disabled:opacity-40"
                >
                  {busy === `twap-${t.id}` && <Spinner />}
                  {busy === `twap-${t.id}` ? "Cancelling…" : "Cancel TWAP"}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {nothing && (
        <EmptyState
          title="No open orders"
          hint="Resting limit orders, TWAPs and anything waiting to be claimed will show up here."
          actionLabel="Make a trade"
          onAction={onGoSwap}
        />
      )}
    </div>
  );
}
