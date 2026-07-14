"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { ArrowDown } from "lucide-react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import {
  ADDR, erc20Abi, fmt, parse, poolAbi, quoterAbi, routerAbi,
} from "@/lib/contracts";
import { RouteSplit, type Quote } from "./RouteSplit";

export function Swap() {
  const { address } = useAccount();
  const client = usePublicClient();
  const { writeContractAsync, isPending } = useWriteContract();

  const [zeroForOne, setZeroForOne] = useState(true); // true = sell USDC
  const [amount, setAmount] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [ammOnly, setAmmOnly] = useState<bigint | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const inSym = zeroForOne ? "USDC" : "EURC";
  const outSym = zeroForOne ? "EURC" : "USDC";
  const amountIn = parse(amount);

  // Quote on every keystroke. It's a view call — it costs nothing.
  useEffect(() => {
    let stale = false;
    if (!client || amountIn === 0n) {
      setQuote(null);
      setAmmOnly(null);
      return;
    }
    (async () => {
      try {
        const [q, a] = await Promise.all([
          client.readContract({
            address: ADDR.quoter as `0x${string}`,
            abi: quoterAbi,
            functionName: "quote",
            args: [zeroForOne, amountIn, 16],
          }),
          client.readContract({
            address: ADDR.pool as `0x${string}`,
            abi: poolAbi,
            functionName: "getDy",
            args: [zeroForOne, amountIn],
          }),
        ]);
        if (stale) return;
        const r = q as unknown as Quote;
        setQuote({ ...r, limitTick: Number(r.limitTick) });
        setAmmOnly(a as bigint);
      } catch {
        if (!stale) setQuote(null);
      }
    })();
    return () => {
      stale = true;
    };
  }, [client, amountIn, zeroForOne]);

  async function onSwap() {
    if (!address || !quote || amountIn === 0n) return;
    const token = (zeroForOne ? ADDR.usdc : ADDR.eurc) as `0x${string}`;

    try {
      setStatus("Approving…");
      await writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [ADDR.router as `0x${string}`, amountIn],
      });

      // 0.5% floor under the quoted output. The only protection that matters.
      const minOut = (quote.expectedOut * 995n) / 1000n;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

      setStatus("Routing…");
      const hash = await writeContractAsync({
        address: ADDR.router as `0x${string}`,
        abi: routerAbi,
        functionName: "swapExactIn",
        args: [
          zeroForOne, amountIn, quote.bookIn, minOut,
          quote.limitTick, 30, deadline, address,
        ],
      });
      setStatus(`Filled · ${hash.slice(0, 10)}…`);
    } catch (e) {
      const m = e instanceof Error ? e.message : "failed";
      setStatus(m.split("\n")[0].slice(0, 90));
    }
  }

  return (
    <div className="rounded-2xl hairline bg-panel p-5">
      <h2 className="text-sm font-medium text-white">Swap</h2>
      <p className="mt-1 text-xs text-muted">
        One transaction. The book first, the curve for the rest.
      </p>

      <div className="mt-5 rounded-xl hairline bg-[#0B0D10] p-4">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-muted">
          <span>You pay</span>
          <span>{inSym}</span>
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          className="mt-2 w-full bg-transparent text-2xl tabular text-white outline-none placeholder:text-[#2A2E36]"
          placeholder="0.00"
        />
      </div>

      <div className="relative h-0">
        <button
          onClick={() => setZeroForOne((v) => !v)}
          aria-label="flip direction"
          className="absolute left-1/2 top-[-14px] z-10 -translate-x-1/2 rounded-lg hairline bg-panel p-2 transition-colors hover:border-accent"
        >
          <ArrowDown size={14} className="text-soft" />
        </button>
      </div>

      <div className="mt-4 rounded-xl hairline bg-[#0B0D10] p-4">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-muted">
          <span>You receive</span>
          <span>{outSym}</span>
        </div>
        <div className="mt-2 text-2xl tabular text-white">
          {quote ? fmt(quote.expectedOut) : "0.0000"}
        </div>
      </div>

      {quote && quote.expectedOut > 0n && (
        <RouteSplit
          quote={quote}
          amountIn={amountIn}
          ammOnly={ammOnly ?? undefined}
          outSymbol={outSym}
        />
      )}

      <motion.button
        whileTap={{ scale: 0.985 }}
        onClick={onSwap}
        disabled={!address || !quote || isPending}
        className="mt-5 w-full rounded-xl bg-white py-3 text-sm font-medium text-ink transition-opacity disabled:opacity-30"
      >
        {!address ? "Connect wallet" : isPending ? "Confirm in wallet…" : "Swap"}
      </motion.button>

      {status && (
        <p className="mt-3 break-words text-center text-[11px] text-muted">
          {status}
        </p>
      )}
    </div>
  );
}
