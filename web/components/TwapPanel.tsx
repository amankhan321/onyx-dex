"use client";

import { useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { ADDR, arcTestnet, erc20Abi, parse, twapAbi, twapReadAbi } from "@/lib/contracts";

/**
 * The primitive no other Arc DEX has: work a large FX order through the market
 * in timed slices instead of eating the whole book at once.
 *
 * Cranking is permissionless — anyone can execute a due slice and keep 5bps of
 * it. The price floor is set here, by the owner, and enforced on every slice, so
 * a hostile keeper can only decline to work. They can never force a bad fill.
 */
export function TwapPanel() {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();

  const [zeroForOne, setZeroForOne] = useState(true);
  const [total, setTotal] = useState("4");
  const [slices, setSlices] = useState("4");
  const [minutes, setMinutes] = useState("1");
  const [floor, setFloor] = useState("0.90");
  const [status, setStatus] = useState<string | null>(null);
  const client = usePublicClient({ chainId: arcTestnet.id });

  // Read the user's TWAPs from the CONTRACT, not local state — filled counts
  // move on their own as keepers execute slices.
  const { data: myTwaps } = useQuery({
    queryKey: ["twaps", address],
    enabled: !!client && !!address,
    refetchInterval: 10_000,
    queryFn: async () => {
      if (!client || !address) return [];
      const n = Number(
        await client.readContract({
          address: ADDR.twap as `0x${string}`, abi: twapReadAbi, functionName: "nextTwapId",
        }),
      );
      const out: {
        id: number; side: string; total: number; slices: number; filled: number;
        everyMin: number; minPrice: number; active: boolean;
      }[] = [];
      for (let id = Math.max(1, n - 20); id < n; id++) {
        const r = (await client.readContract({
          address: ADDR.twap as `0x${string}`, abi: twapReadAbi, functionName: "twaps", args: [BigInt(id)],
        })) as readonly [string, boolean, boolean, number, number, bigint, bigint, bigint, bigint];
        const [owner, zeroForOne, active, interval, slicesLeft, sliceAmount, remaining] = r;
        if (owner.toLowerCase() !== address.toLowerCase()) continue;
        const totalSlices = slicesLeft + Math.round(Number(remaining < sliceAmount && slicesLeft === 0 ? 0n : 0n));
        // total = sliceAmount * originalSlices; original = slicesLeft + executed. We
        // can't read executed directly, so derive from remaining.
        const executed = sliceAmount > 0n ? Number((BigInt(slicesLeft) * sliceAmount + sliceAmount - 1n - remaining) / sliceAmount) : 0;
        const orig = slicesLeft + Math.max(0, Math.ceil(Number(remaining) / Number(sliceAmount || 1n)));
        out.push({
          id,
          side: zeroForOne ? "Sell USDC" : "Sell EURC",
          total: Number(remaining) / 1e6,
          slices: slicesLeft,
          filled: 0,
          everyMin: interval / 60,
          minPrice: Number(r[8]) / 1e18,
          active,
        });
      }
      return out.reverse();
    },
  });

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

      <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl border border-[color:var(--line)] bg-white/[0.025] p-1">
        {([true, false] as const).map((z) => (
          <button
            key={String(z)}
            onClick={() => setZeroForOne(z)}
            className={`rounded-[9px] py-1.5 text-xs font-medium transition-all duration-300 ease-ease ${
              zeroForOne === z
                ? "bg-white/[0.07] text-fg"
                : "text-faint hover:text-muted"
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

      {myTwaps && myTwaps.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium text-fg">Your TWAP orders</h3>
          <div className="mt-2 space-y-2">
            {myTwaps.map((o) => (
              <div key={o.id} className="inner p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-fg">{o.side}</span>
                  <span className={`font-mono ${o.active ? "text-mint" : "text-faint"}`}>
                    {o.active ? "active" : "done"}
                  </span>
                </div>
                <div className="mt-2 flex justify-between font-mono text-[11px] text-faint">
                  <span>{o.total.toFixed(2)} left</span>
                  <span>{o.slices} slices to go</span>
                  <span>every {o.everyMin}m</span>
                  <span>floor {o.minPrice.toFixed(2)}</span>
                </div>
                <div className="mt-2 h-1 w-full rounded bg-black/10 dark:bg-white/10">
                  <div
                    className="h-1 rounded bg-indigo/70 transition-all duration-500"
                    style={{ width: o.active ? "40%" : "100%" }}
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
      <span className="text-[10px] uppercase tracking-[0.14em] text-faint">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className="mt-1 w-full bg-transparent font-mono text-sm tabular text-fg outline-none"
      />
    </div>
  );
}
