"use client";

import { useEffect, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { decodeEventLog } from "viem";
import { ADDR, arcTestnet, erc20Abi, parse, twapAbi } from "@/lib/contracts";

/**
 * TWAP: work a large FX order through the market in timed slices instead of
 * eating the whole book at once. Cranking is permissionless — anyone can execute
 * a due slice and keep 5bps; the owner's per-slice price floor is enforced
 * on-chain, so a hostile keeper can only decline, never force a bad fill.
 */
type TwapOrder = {
  id: string; // tx hash (display)
  twapId?: string; // on-chain id for cancel
  side: string;
  total: string;
  slices: number;
  filled: number;
  everyMin: number;
  minPrice: string;
  status: "active" | "done" | "cancelled";
  createdAt: number;
};

export function TwapPanel() {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const client = usePublicClient({ chainId: arcTestnet.id });

  const createdAbi = [{
    type: "event", name: "TwapCreated",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "zeroForOne", type: "bool", indexed: false },
      { name: "total", type: "uint256", indexed: false },
      { name: "slices", type: "uint32", indexed: false },
      { name: "interval", type: "uint32", indexed: false },
    ],
  }] as const;

  async function cancelTwap(o: TwapOrder) {
    if (o.twapId == null) return;
    try {
      setStatus("Cancelling…");
      await writeContractAsync({
        address: ADDR.twap as `0x${string}`,
        abi: twapAbi,
        functionName: "cancelTwap",
        args: [BigInt(o.twapId)],
        chainId: arcTestnet.id,
      });
      setTwapOrders((prev) => {
        const next = prev.filter((x) => x.id !== o.id);
        if (twapKey) localStorage.setItem(twapKey, JSON.stringify(next));
        return next;
      });
      setStatus("Cancelled — remaining amount refunded");
    } catch (e) {
      const m = e instanceof Error ? e.message : "failed";
      setStatus(m.split("\n")[0].slice(0, 90));
    }
  }

  const [zeroForOne, setZeroForOne] = useState(true);
  const [total, setTotal] = useState("4");
  const [slices, setSlices] = useState("4");
  const [minutes, setMinutes] = useState("1");
  const [floor, setFloor] = useState("0.90");
  const [status, setStatus] = useState<string | null>(null);
  const [twapOrders, setTwapOrders] = useState<TwapOrder[]>([]);

  // Load persisted TWAP orders on mount / wallet change.
  const twapKey = address ? `onyx-twaps-${address.toLowerCase()}` : null;
  useEffect(() => {
    if (!twapKey) return;
    try {
      setTwapOrders(JSON.parse(localStorage.getItem(twapKey) ?? "[]"));
    } catch {
      setTwapOrders([]);
    }
  }, [twapKey]);

  const inSym = zeroForOne ? "USDC" : "EURC";

  async function create() {
    if (!address) return;
    const amount = parse(total);
    const n = Number(slices);
    const interval = Math.max(1, Math.round(Number(minutes) * 60));
    const minPriceX18 = BigInt(Math.floor(Number(floor) * 1e18));
    if (amount === 0n || !n || !minPriceX18) return;

    const token = (zeroForOne ? ADDR.usdc : ADDR.eurc) as `0x${string}`;

    try {
      setStatus("Approving…");
      await writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [ADDR.twap as `0x${string}`, amount],
        chainId: arcTestnet.id,
      });

      setStatus("Scheduling…");
      const hash = await writeContractAsync({
        address: ADDR.twap as `0x${string}`,
        abi: twapAbi,
        functionName: "createTwap",
        args: [zeroForOne, amount, n, interval, minPriceX18],
        chainId: arcTestnet.id,
      });

      let twapId: string | undefined;
      try {
        const receipt = await client!.waitForTransactionReceipt({ hash });
        for (const log of receipt.logs) {
          try {
            const ev = decodeEventLog({ abi: createdAbi, data: log.data, topics: log.topics });
            if (ev.eventName === "TwapCreated") {
              twapId = String((ev.args as { id: bigint }).id);
              break;
            }
          } catch {}
        }
      } catch {}

      setTwapOrders((prev) => {
        const next = [
          {
            id: hash,
            twapId,
            side: `Sell ${inSym}`,
            total,
            slices: n,
            filled: 0,
            everyMin: Number(minutes),
            minPrice: floor,
            status: "active" as const,
            createdAt: Date.now(),
          },
          ...prev,
        ];
        if (twapKey) localStorage.setItem(twapKey, JSON.stringify(next));
        return next;
      });
      setStatus(`Scheduled · ${hash.slice(0, 10)}…`);
    } catch (e) {
      const m = e instanceof Error ? e.message : "failed";
      setStatus(m.split("\n")[0].slice(0, 90));
    }
  }

  return (
    <div>
      <h2 className="text-sm font-medium text-fg">TWAP</h2>
      <p className="mt-1 text-xs leading-relaxed text-faint">
        Slice a large order over time. Keepers execute due slices for 5bps; your
        price floor is enforced on every one, so they can decline but never
        overreach.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl border border-[color:var(--line)] bg-black/[0.04] p-1 dark:bg-white/[0.025]">
        {([true, false] as const).map((z) => (
          <button
            key={String(z)}
            onClick={() => setZeroForOne(z)}
            className={`rounded-[9px] py-1.5 text-xs font-medium transition-all duration-300 ease-ease ${
              zeroForOne === z ? "bg-indigo/20 text-fg" : "text-faint hover:text-muted"
            }`}
          >
            Sell {z ? "USDC" : "EURC"}
          </button>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label={`Total (${inSym})`} value={total} onChange={setTotal} />
        <Field label="Slices" value={slices} onChange={setSlices} />
        <Field label="Every (min)" value={minutes} onChange={setMinutes} />
        <Field label="Min price" value={floor} onChange={setFloor} />
      </div>

      <button
        onClick={create}
        disabled={!address || isPending}
        className="cta mt-4 w-full bg-indigo/80 py-2.5 text-sm font-medium text-white disabled:opacity-25"
      >
        {!address ? "Connect wallet" : "Schedule TWAP"}
      </button>

      {status && (
        <p className="mt-3 break-words text-center font-mono text-[11px] text-muted">
          {status}
        </p>
      )}

      {twapOrders.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium text-fg">Your TWAP orders</h3>
          <div className="mt-2 space-y-2">
            {twapOrders.map((o) => (
              <div key={o.id} className="inner p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-fg">{o.side}</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-muted">{o.id.slice(0, 10)}…</span>
                    {o.twapId != null && (
                      <button
                        onClick={() => cancelTwap(o)}
                        className="btn rounded-lg border border-rose/40 px-2.5 py-1 text-[11px] text-rose hover:bg-rose/10"
                      >
                        Cancel
                      </button>
                    )}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap justify-between gap-x-3 gap-y-1 font-mono text-[11px] text-faint">
                  <span>total {o.total}</span>
                  <span>
                    {o.filled}/{o.slices} slices
                  </span>
                  <span>every {o.everyMin}m</span>
                  <span>floor {o.minPrice}</span>
                </div>
                <div className="mt-2 h-1 w-full rounded bg-black/10 dark:bg-white/10">
                  <div
                    className="h-1 rounded bg-indigo transition-all duration-500"
                    style={{ width: `${(o.filled / o.slices) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inner p-3">
      <span className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className="mt-1 w-full bg-transparent font-mono text-sm tabular text-fg outline-none"
      />
    </div>
  );
}
