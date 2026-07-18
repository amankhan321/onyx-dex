"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { useAccount, useBalance, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { decodeEventLog } from "viem";
import { usePool } from "@/lib/useBook";
import { ADDR, arcTestnet, bookAbi, erc20Abi, parse, tickOf } from "@/lib/contracts";

const placedAbi = [
  {
    type: "event",
    name: "OrderPlaced",
    inputs: [
      { name: "id", type: "uint64", indexed: true },
      { name: "maker", type: "address", indexed: true },
      { name: "isBid", type: "bool", indexed: false },
      { name: "tick", type: "uint32", indexed: false },
      { name: "baseAmount", type: "uint128", indexed: false },
      { name: "quoteEscrow", type: "uint256", indexed: false },
    ],
  },
] as const;

export function LimitPanel() {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const { data: gasBal } = useBalance({ address, chainId: arcTestnet.id, query: { enabled: !!address } });
  const noGas = !!address && gasBal != null && gasBal.value === 0n;
  const { data: pool } = usePool();
  const { data: eurcBal } = useReadContract({
    address: ADDR.eurc as `0x${string}`, abi: erc20Abi, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: arcTestnet.id, query: { enabled: !!address },
  });



  const [isBid, setIsBid] = useState(true);
  const [price, setPrice] = useState("0.9300");
  const [size, setSize] = useState("2");
  const [status, setStatus] = useState<string | null>(null);

  type OpenOrder = { id: bigint; side: string; price: string; size: string; tx: string };
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const client = usePublicClient({ chainId: arcTestnet.id });

  // Pre-flight checks (the contract enforces all of this on-chain too — these
  // exist so the user sees the problem BEFORE MetaMask, not as a revert).
  const priceNum = Number(price) || 0;
  const sizeAmt = parse(size);
  const escrowNeeded = isBid
    ? BigInt(Math.ceil(priceNum * Number(sizeAmt))) // EURC, 6-dec
    : sizeAmt; // USDC
  const escrowBal: bigint | undefined = isBid
    ? (eurcBal as bigint | undefined)
    : gasBal ? gasBal.value / 10n ** 12n : undefined;
  const insufficientEscrow =
    !!address && escrowBal != null && sizeAmt > 0n && escrowNeeded > escrowBal;
  // Off-market warning: a bid above the curve (or ask below) gets picked off
  // instantly at the maker's loss. Warn past 1% deviation.
  const mkt = pool?.ammPrice ?? 0;
  const offMarketPct =
    mkt > 0 && priceNum > 0
      ? isBid
        ? ((priceNum - mkt) / mkt) * 100
        : ((mkt - priceNum) / mkt) * 100
      : 0;
  const offMarket = offMarketPct > 1;

  async function place() {
    if (!address) return;
    const tick = tickOf(Number(price));
    const baseAmount = parse(size);
    if (!tick || baseAmount === 0n) return;

    // A bid escrows quote (size x price); an ask escrows base.
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
        chainId: arcTestnet.id,
      });

      setStatus("Resting order…");
      const hash = await writeContractAsync({
        address: ADDR.book as `0x${string}`,
        abi: bookAbi,
        functionName: "placeOrder",
        args: [isBid, tick, baseAmount],
        chainId: arcTestnet.id,
      });

      // Pull the order id out of the OrderPlaced event so we can cancel it later.
      let placedId: bigint | undefined;
      try {
        const receipt = await client!.waitForTransactionReceipt({ hash });
        for (const log of receipt.logs) {
          try {
            const ev = decodeEventLog({ abi: placedAbi, data: log.data, topics: log.topics });
            if (ev.eventName === "OrderPlaced") {
              placedId = (ev.args as { id: bigint }).id;
              break;
            }
          } catch {}
        }
      } catch {}

      if (placedId != null) {
        setOrders((prev) => [
          { id: placedId!, side: isBid ? "Buy USDC" : "Sell USDC", price, size, tx: hash },
          ...prev,
        ]);
      }
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
        chainId: arcTestnet.id,
      });
      setStatus("Claimed");
    } catch {
      setStatus("Nothing to claim");
    }
  }

  async function cancel(id: bigint) {
    try {
      setStatus("Cancelling…");
      await writeContractAsync({
        address: ADDR.book as `0x${string}`,
        abi: bookAbi,
        functionName: "cancelOrder",
        args: [id],
        chainId: arcTestnet.id,
      });
      setOrders((prev) => prev.filter((o) => o.id !== id));
      setStatus("Cancelled — claim to withdraw the escrow");
    } catch (e) {
      const m = e instanceof Error ? e.message : "failed";
      setStatus(m.split("\n")[0].slice(0, 90));
    }
  }

  return (
    <div>
      <h2 className="text-sm font-medium text-fg">Make</h2>
      <p className="mt-1 text-xs leading-relaxed text-faint">
        Post-only. An order that would cross the spread is rejected, not filled —
        makers make, takers take, and the paths never interleave.
      </p>

      <div className="relative mt-4 grid grid-cols-2 gap-1 rounded-xl border border-[color:var(--line)] bg-white/[0.025] p-1">
        {([true, false] as const).map((b) => (
          <button
            key={String(b)}
            onClick={() => setIsBid(b)}
            className="relative rounded-[9px] py-1.5 text-xs font-medium"
          >
            {isBid === b && (
              <motion.span
                layoutId="side-pill"
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
                className={`absolute inset-0 rounded-[9px] ${b ? "bg-mint/[0.14]" : "bg-rose/[0.14]"}`}
              />
            )}
            <span
              className={`relative transition-colors duration-300 ease-ease ${
                isBid === b ? (b ? "text-mint" : "text-rose") : "text-faint hover:text-muted"
              }`}
            >
              {b ? "Buy USDC" : "Sell USDC"}
            </span>
          </button>
        ))}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Price (EURC)" value={price} onChange={setPrice} />
        <Field label="Size (USDC)" value={size} onChange={setSize} />
      </div>

      {sizeAmt > 0n && priceNum > 0 && (
        <p className="mt-3 text-center font-mono text-[11px] text-muted">
          Escrow: {(Number(escrowNeeded) / 1e6).toFixed(4)} {isBid ? "EURC" : "USDC"}
          {escrowBal != null && ` · you have ${(Number(escrowBal) / 1e6).toFixed(4)}`}
        </p>
      )}
      {offMarket && (
        <p className="mt-2 rounded-lg border border-yellow-500/30 bg-yellow-500/[0.08] p-2 text-center text-[11px] text-yellow-600">
          {offMarketPct.toFixed(1)}% {isBid ? "above" : "below"} market ({mkt.toFixed(4)}) — this
          order will be filled immediately at your loss
        </p>
      )}
      <button
        onClick={place}
        disabled={!address || isPending || noGas || insufficientEscrow}
        className="cta mt-4 w-full bg-indigo/80 py-2.5 text-sm font-medium text-white disabled:opacity-25"
      >
        {!address ? "Connect wallet" : noGas ? "Need USDC for gas (faucet)" : insufficientEscrow ? `Insufficient ${isBid ? "EURC" : "USDC"} balance` : "Place limit order"}
      </button>

      <button
        onClick={claim}
        disabled={!address}
        className="btn mt-2 w-full border border-[color:var(--line)] py-2.5 text-xs text-muted hover:text-fg disabled:opacity-25"
      >
        Claim fills
      </button>

      {orders.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium text-fg">Your open orders</h3>
          <div className="mt-2 space-y-2">
            {orders.map((o) => (
              <div key={o.id.toString()} className="inner flex items-center justify-between p-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-fg">{o.side}</div>
                  <div className="font-mono text-[11px] text-faint">
                    {o.size} @ {o.price} · #{o.id.toString()}
                  </div>
                </div>
                <button
                  onClick={() => cancel(o.id)}
                  className="btn shrink-0 rounded-lg border border-rose/40 px-3 py-1.5 text-[11px] text-rose hover:bg-rose/10"
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
          <p className="mt-2 text-center text-[10px] text-faint">
            Cancelling returns your escrow to claimable — hit &quot;Claim fills&quot; after.
          </p>
        </div>
      )}

      {status && (
        <p className="mt-3 break-words text-center font-mono text-[11px] text-muted">
          {status}
        </p>
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
