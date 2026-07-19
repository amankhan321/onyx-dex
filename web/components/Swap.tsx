"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ChevronDown } from "lucide-react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { ADDR, arcTestnet, erc20Abi, fmt, parse, poolAbi, quoterAbi, routerAbi } from "@/lib/contracts";
import { useBalance, useReadContract } from "wagmi";
import { RouteSplit, type Quote } from "./RouteSplit";
import { SwapModal, type SwapStage } from "./SwapModal";

export function Swap() {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: arcTestnet.id });
  const { writeContractAsync, isPending } = useWriteContract();

  const [zeroForOne, setZeroForOne] = useState(true);
  const [amount, setAmount] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [ammOnly, setAmmOnly] = useState<bigint | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [stage, setStage] = useState<SwapStage>("idle");
  const [modalOpen, setModalOpen] = useState(false);
  const [txHash, setTxHash] = useState<string>();

  const inSym = zeroForOne ? "USDC" : "EURC";
  const outSym = zeroForOne ? "EURC" : "USDC";
  const [openSel, setOpenSel] = useState<"in" | "out" | null>(null);

  const TokenPill = ({ sym, side }: { sym: string; side: "in" | "out" }) => (
    <div className="relative">
      <button
        onClick={() => setOpenSel(openSel === side ? null : side)}
        className="flex items-center gap-1.5 rounded-full border border-[color:var(--line)] bg-[color:var(--raise)] px-2.5 py-1.5 text-xs font-semibold text-fg transition-colors hover:brightness-110"
      >
        <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold text-white ${sym === "USDC" ? "bg-[#2775CA]" : "bg-[#3550c8]"}`}>
          {sym === "USDC" ? "$" : "€"}
        </span>
        {sym}
        <ChevronDown size={12} className="text-muted" />
      </button>
      {openSel === side && (
        <div className="absolute right-0 z-30 mt-1 w-28 overflow-hidden rounded-xl border border-[color:var(--line)] bg-[color:var(--raise)] shadow-xl">
          {["USDC", "EURC"].map((s) => (
            <button
              key={s}
              onClick={() => {
                if (s !== sym) setZeroForOne((v) => !v);
                setOpenSel(null);
              }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-xs ${s === sym ? "text-fg" : "text-muted hover:bg-black/5 hover:text-fg"}`}
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

  // Balance of the token being SOLD, to gate the swap button.
  const { data: nativeBal } = useBalance({ address, chainId: arcTestnet.id, query: { enabled: !!address } });
  const { data: eurcBal } = useReadContract({
    address: ADDR.eurc as `0x${string}`,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: arcTestnet.id,
    query: { enabled: !!address },
  });
  // zeroForOne = selling USDC (native gas token, 18-dec balance but 6-dec in our math);
  // otherwise selling EURC (ERC20, 6-dec). Compare in the token's own base units.
  const payBalance: bigint | undefined = zeroForOne
    ? nativeBal
      ? nativeBal.value / 10n ** 12n // 18dec native -> 6dec compare
      : undefined
    : (eurcBal as bigint | undefined);
  const insufficient =
    address != null && payBalance != null && amountIn > 0n && amountIn > payBalance;

  // Quote: ONE multicall (quoter + AMM baseline together), debounced 350ms,
  // and resilient — a transient RPC blip KEEPS the last good quote on screen
  // instead of flashing "0.0000 + error". Only a quote that fails repeatedly
  // for a NEW amount surfaces an error.
  useEffect(() => {
    let stale = false;
    if (!client || amountIn === 0n) {
      setQuote(null);
      setAmmOnly(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const [q, a] = (await client.multicall({
          allowFailure: false,
          contracts: [
            {
              address: ADDR.quoter as `0x${string}`,
              abi: quoterAbi,
              functionName: "quote",
              args: [zeroForOne, amountIn, 16],
            },
            {
              address: ADDR.pool as `0x${string}`,
              abi: poolAbi,
              functionName: "getDy",
              args: [zeroForOne, amountIn],
            },
          ],
        })) as [unknown, bigint];
        if (stale) return;
        const r = q as Quote;
        setQuote({ ...r, limitTick: Number(r.limitTick) });
        setAmmOnly(a);
        setStatus(null);
      } catch (e) {
        if (stale) return;
        // Keep last good quote through blips; only error if we have nothing.
        if (!quote) {
          const m = e instanceof Error ? e.message : "quote failed";
          setStatus(
            m.includes("0xec30f4ab")
              ? "FX oracle stale — swaps paused by design until the next rate update"
              : `quote error: ${m.split("\n")[0].slice(0, 120)}`,
          );
        }
      }
    }, 350);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, amountIn, zeroForOne]);

  async function onSwap() {
    if (!address || !quote || amountIn === 0n) return;
    const token = (zeroForOne ? ADDR.usdc : ADDR.eurc) as `0x${string}`;
    setModalOpen(true);
    setTxHash(undefined);
    try {
      setStage("approving");
      await writeContractAsync({
        address: token,
        abi: erc20Abi,
        functionName: "approve",
        args: [ADDR.router as `0x${string}`, amountIn],
        chainId: arcTestnet.id,
      });

      const minOut = (quote.expectedOut * 995n) / 1000n; // 0.5% floor
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

      setStage("swapping");
      const hash = await writeContractAsync({
        address: ADDR.router as `0x${string}`,
        abi: routerAbi,
        functionName: "swapExactIn",
        args: [zeroForOne, amountIn, quote.bookIn, minOut, quote.limitTick, 30, deadline, address],
        chainId: arcTestnet.id,
      });
      setTxHash(hash);
      setStage("done");
      setStatus(`Filled · ${hash.slice(0, 10)}…`);
    } catch (e) {
      const m = e instanceof Error ? e.message : "failed";
      setStage("error");
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
          className="btn absolute left-1/2 top-[-15px] z-10 -translate-x-1/2 border border-[color:var(--line)] bg-raise p-2"
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
        disabled={!address || !quote || isPending || insufficient}
        className={`mt-5 w-full rounded-full py-3 text-sm font-medium transition-all ${
          insufficient
            ? "cursor-not-allowed bg-black/10 text-faint dark:bg-white/10"
            : "cta bg-indigo/80 text-white disabled:opacity-25"
        }`}
      >
        {!address
          ? "Connect wallet"
          : insufficient
            ? `Insufficient ${inSym} balance`
            : isPending
              ? "Confirm in wallet…"
              : "Swap"}
      </button>

      <SwapModal
        open={modalOpen}
        stage={stage}
        fromSym={inSym}
        toSym={outSym}
        amountIn={amountIn}
        amountOut={quote?.expectedOut ?? 0n}
        txHash={txHash}
        error={status ?? undefined}
        onClose={() => setModalOpen(false)}
      />

      {status && stage === "idle" && (
        <p className="mt-3 break-words text-center font-mono text-[11px] text-muted">
          {status}
        </p>
      )}

      <p className="mt-3 flex items-center justify-center gap-1.5 text-[10px] text-faint">
        <span className="h-1 w-1 rounded-full bg-mint" />
        Built on Arc · Sub-second finality · ~$0.01 fees
      </p>
    </div>
  );
}
