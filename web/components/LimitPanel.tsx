"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useAccount, useWriteContract } from "wagmi";
import { ADDR, bookAbi, erc20Abi, parse, tickOf } from "@/lib/contracts";

export function LimitPanel() {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();

  const [isBid, setIsBid] = useState(true);
  const [price, setPrice] = useState("0.9300");
  const [size, setSize] = useState("2");
  const [status, setStatus] = useState<string | null>(null);

  async function place() {
    if (!address) return;
    const tick = tickOf(Number(price));
    const baseAmount = parse(size);
    if (!tick || baseAmount === 0n) return;

    // A bid escrows quote (size x price), an ask escrows base.
    const token = (isBid ? ADDR.eurc : ADDR.usdc) as `0x${string}`;
    const escrow = isBid
      ? (baseAmount * BigInt(tick) * 10n ** 13n) / 10n ** 18n + 1n
      : baseAmount;

    try {
      setStatus("Approving…");
      await writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [ADDR.book as `0x${string}`, escrow],
      });

      setStatus("Resting order…");
      const hash = await writeContractAsync({
        address: ADDR.book as `0x${string}`,
        abi: bookAbi,
        functionName: "placeOrder",
        args: [isBid, tick, baseAmount],
      });
      setStatus(`Resting · ${hash.slice(0, 10)}…`);
    } catch (e) {
      const m = e instanceof Error ? e.message : "failed";
      setStatus(
        m.includes("WouldCross")
          ? "Post-only: that price would cross the spread"
          : m.split("\n")[0].slice(0, 90),
      );
    }
  }

  async function claim() {
    try {
      setStatus("Claiming…");
      await writeContractAsync({
        address: ADDR.book as `0x${string}`,
        abi: bookAbi,
        functionName: "claim",
      });
      setStatus("Claimed");
    } catch {
      setStatus("Nothing to claim");
    }
  }

  return (
    <div className="rounded-2xl hairline bg-panel p-5">
      <h2 className="text-sm font-medium text-white">Make</h2>
      <p className="mt-1 text-xs text-muted">
        Post-only. Crossing orders are rejected, not filled.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-[#0B0D10] p-1 hairline">
        {([true, false] as const).map((b) => (
          <button
            key={String(b)}
            onClick={() => setIsBid(b)}
            className={`rounded-md py-1.5 text-xs font-medium transition-colors ${
              isBid === b
                ? b
                  ? "bg-bid/15 text-bid"
                  : "bg-ask/15 text-ask"
                : "text-muted hover:text-soft"
            }`}
          >
            {b ? "Buy USDC" : "Sell USDC"}
          </button>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Price (EURC)" value={price} onChange={setPrice} />
        <Field label="Size (USDC)" value={size} onChange={setSize} />
      </div>

      <motion.button
        whileTap={{ scale: 0.985 }}
        onClick={place}
        disabled={!address || isPending}
        className="mt-4 w-full rounded-xl bg-white/95 py-2.5 text-sm font-medium text-ink disabled:opacity-30"
      >
        {!address ? "Connect wallet" : "Place limit order"}
      </motion.button>

      <button
        onClick={claim}
        disabled={!address}
        className="mt-2 w-full rounded-xl hairline py-2.5 text-xs text-soft transition-colors hover:border-accent disabled:opacity-30"
      >
        Claim fills
      </button>

      {status && (
        <p className="mt-3 break-words text-center text-[11px] text-muted">{status}</p>
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
    <div className="rounded-xl hairline bg-[#0B0D10] p-3">
      <span className="text-[10px] uppercase tracking-[0.14em] text-muted">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        className="mt-1 w-full bg-transparent text-sm tabular text-white outline-none"
      />
    </div>
  );
}
