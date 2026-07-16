"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ChevronDown } from "lucide-react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { ADDR, arcTestnet, erc20Abi, fmt, parse, poolAbi, quoterAbi, routerAbi } from "@/lib/contracts";
import { RouteSplit, type Quote } from "./RouteSplit";

export function Swap() {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: arcTestnet.id });
  const { writeContractAsync, isPending } = useWriteContract();

  const [zeroForOne, setZeroForOne] = useState(true);
  const [amount, setAmount] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [ammOnly, setAmmOnly] = useState<bigint | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const inSym = zeroForOne ? "USDC" : "EURC";
  const outSym = zeroForOne ? "EURC" : "USDC";
  const [openSel, setOpenSel] = useState<"in" | "out" | null>(null);

  const TokenPill = ({ sym, side }: { sym: string; side: "in" | "out" }) => (
    <div className="relative">
      <button
        onClick={() => setOpenSel(openSel === side ? null : side)}
        className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#232c40] px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[#2a3550]"
      >
        <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white ${sym === "USDC" ? "bg-[#2775CA]" : "bg-[#3550c8]"}`}>
          {sym === "USDC" ? "$" : "€"}
        </span>
        {sym}
        <ChevronDown size={12} className="text-muted" />
      </button>
      {openSel === side && (
        <div className="absolute right-0 z-30 mt-1 w-28 overflow-hidden rounded-xl border border-white/10 bg-[#1c2333] shadow-xl">
          {["USDC", "EURC"].map((s) => (
            <button
              key={s}
              onClick={() => {
                if (s !== sym) setZeroForOne((v) => !v);
                setOpenSel(null);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-xs ${s === sym ? "text-white" : "text-muted hover:bg-white/5 hover:text-white"}`}
            >
              <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white ${s === "USDC" ? "bg-[#2775CA]" : "bg-[#3550c8]"}`}>
                {s === "USDC" ? "$" : "€"}
              </span>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  const amountIn = parse(amount);

  // Quoting is a view call. It costs nothing, so we do it on every keystroke.
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
      } catch (e) {
        if (!stale) {
          setQuote(null);
          const m = e instanceof Error ? e.message : "quote failed";
          setStatus(
            m.includes("0xec30f4ab")
              ? "FX oracle stale — swaps paused by design until the next rate update"
              : `quote error: ${m.split("\n")[0].slice(0, 120)}`,
          );
        }
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
        chainId: arcTestnet.id,
      });

      const minOut = (quote.expectedOut * 995n) / 1000n; // 0.5% floor
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

      setStatus("Routing…");
      const hash = await writeContractAsync({
        address: ADDR.router as `0x${string}`,
        abi: routerAbi,
        functionName: "swapExactIn",
        args: [zeroForOne, amountIn, quote.bookIn, minOut, quote.limitTick, 30, deadline, address],
        chainId: arcTestnet.id,
      });
      setStatus(`Filled · ${hash.slice(0, 10)}…`);
    } catch (e) {
      const m = e instanceof Error ? e.message : "failed";
      setStatus(m.split("\n")[0].slice(0, 90));
    }
  }

  return (
    <div>
      <div className="inner p-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted">You pay</span>
          <TokenPill sym={inSym} side="in" />
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          className="mt-2 w-full bg-transparent font-mono text-[26px] tabular text-fg outline-none placeholder:text-faint/40"
        />
      </div>

      <div className="relative h-0">
        <button
          onClick={() => setZeroForOne((v) => !v)}
          aria-label="Flip direction"
          className="btn absolute left-1/2 top-[-15px] z-10 -translate-x-1/2 border border-white/[0.1] bg-raise p-2"
        >
          <ArrowDown size={14} className="text-muted" />
        </button>
      </div>

      <div className="inner mt-4 p-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-muted">You receive</span>
          <TokenPill sym={outSym} side="out" />
        </div>
        <div className="mt-2 font-mono text-[26px] tabular text-fg">
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

      <button
        onClick={onSwap}
        disabled={!address || !quote || isPending}
        className="cta mt-5 w-full bg-indigo/80 py-3 text-sm font-medium text-white disabled:opacity-25"
      >
        {!address ? "Connect wallet" : isPending ? "Confirm in wallet…" : "Swap"}
      </button>

      {status && (
        <p className="mt-3 break-words text-center font-mono text-[11px] text-muted">
          {status}
        </p>
      )}

      <p className="mt-3 flex items-center justify-center gap-1.5 text-[10px] text-faint">
        <span className="h-1 w-1 rounded-full bg-mint" />
        Powered by Arc Network · Sub-second finality · ~$0.01 fees
      </p>
    </div>
  );
}
