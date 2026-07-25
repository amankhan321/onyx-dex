"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import {
  ADDR,
  arcTestnet,
  bookAbi,
  erc20Abi,
  fmt,
  parse,
  poolAbi,
  quoterAbi,
  routerAbi,
  tickOf,
} from "@/lib/contracts";
import { useBook, usePool } from "@/lib/useBook";

/**
 * MODE 1 — CLIENT-SIDE BOT. Runs entirely in this browser tab against the
 * user's OWN connected wallet: every order and swap is a normal wagmi write
 * that the user signs in their wallet. No private key is ever requested,
 * stored, or transmitted, and nothing runs when the tab is closed.
 *
 * Consequence the UI states plainly: because each action is user-signed, the
 * wallet will prompt on every trade. This is automation of *decisions*, not
 * custody — the alternative (a key in the browser) is not something we build.
 *
 * Strategies all trade the existing contracts:
 *  - Market-making: post-only maker quotes either side of mid on OrderBook.
 *  - Grid:          Router swaps when price crosses a grid line.
 *  - DCA:           fixed-size Router swap every interval.
 * The Quoter decides the book/AMM split on every Router swap.
 */

type Strategy = "mm" | "grid" | "dca";
type LogLine = { t: number; msg: string; kind: "info" | "act" | "err" };

const STRATEGIES: { id: Strategy; label: string; blurb: string }[] = [
  { id: "mm", label: "Market-making", blurb: "Post-only maker quotes either side of mid. Earns the spread when both sides fill." },
  { id: "grid", label: "Grid", blurb: "Buys below the grid mid, sells above it. Profits from range-bound chop." },
  { id: "dca", label: "TWAP-style DCA", blurb: "Fixed-size swap every interval, one direction. Averages the entry." },
];

export function BotPanel() {
  const { address } = useAccount();
  const client = usePublicClient({ chainId: arcTestnet.id });
  const { writeContractAsync } = useWriteContract();
  const { data: book } = useBook();
  const { data: pool } = usePool();

  const [strategy, setStrategy] = useState<Strategy>("mm");
  const [size, setSize] = useState("1");
  const [spreadBps, setSpreadBps] = useState("40");
  const [maxCapital, setMaxCapital] = useState("5");
  const [intervalS, setIntervalS] = useState("60");
  const [dcaSell, setDcaSell] = useState(true);

  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [deployed, setDeployed] = useState(0); // capital committed this session
  const [openOrders, setOpenOrders] = useState<{ id: string; side: string; price: string }[]>([]);
  const [startValue, setStartValue] = useState<number | null>(null);
  const [pnl, setPnl] = useState<number | null>(null);

  // Refs so the loop always sees fresh config without being restarted.
  const cfg = useRef({ strategy, size, spreadBps, maxCapital, intervalS, dcaSell, deployed });
  cfg.current = { strategy, size, spreadBps, maxCapital, intervalS, dcaSell, deployed };
  const bookRef = useRef(book);
  bookRef.current = book;
  const poolRef = useRef(pool);
  poolRef.current = pool;
  const busy = useRef(false);
  const errors = useRef(0);

  const say = (msg: string, kind: LogLine["kind"] = "info") =>
    setLog((l) => [{ t: Date.now(), msg, kind }, ...l].slice(0, 40));

  /** Portfolio value in USDC terms, for a simple honest session P&L. */
  async function portfolioValue(): Promise<number | null> {
    if (!client || !address) return null;
    try {
      const [u, e] = (await client.multicall({
        allowFailure: false,
        contracts: [
          { address: ADDR.usdc as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [address] },
          { address: ADDR.eurc as `0x${string}`, abi: erc20Abi, functionName: "balanceOf", args: [address] },
        ],
      })) as [bigint, bigint];
      const px = poolRef.current?.ammPrice ?? 1;
      return Number(u) / 1e6 + Number(e) / 1e6 / px;
    } catch {
      return null;
    }
  }

  async function approveIfNeeded(token: string, spender: string, amount: bigint) {
    if (!client || !address) return;
    const allowance = (await client.readContract({
      address: token as `0x${string}`,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, spender as `0x${string}`],
    })) as bigint;
    if (allowance >= amount) return;
    say("approving…");
    await writeContractAsync({
      address: token as `0x${string}`,
      abi: erc20Abi,
      functionName: "approve",
      args: [spender as `0x${string}`, amount * 20n],
      chainId: arcTestnet.id,
    });
  }

  /** Router swap sized by the Quoter's optimal book/AMM split. */
  async function routerSwap(zeroForOne: boolean, amountIn: bigint) {
    if (!client || !address) return;
    const q = (await client.readContract({
      address: ADDR.quoter as `0x${string}`,
      abi: quoterAbi,
      functionName: "quote",
      args: [zeroForOne, amountIn, 16],
    })) as { bookIn: bigint; expectedOut: bigint; limitTick: number };

    if (q.expectedOut === 0n) {
      say("quoter returned 0 — skipping tick", "err");
      return;
    }
    await approveIfNeeded(zeroForOne ? ADDR.usdc : ADDR.eurc, ADDR.router, amountIn);
    const minOut = (q.expectedOut * 995n) / 1000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const hash = await writeContractAsync({
      address: ADDR.router as `0x${string}`,
      abi: routerAbi,
      functionName: "swapExactIn",
      args: [zeroForOne, amountIn, q.bookIn, minOut, Number(q.limitTick), 30, deadline, address],
      chainId: arcTestnet.id,
    });
    say(`swap ${zeroForOne ? "USDC→EURC" : "EURC→USDC"} ${fmt(amountIn, 2)} · ${hash.slice(0, 10)}…`, "act");
  }

  /** Post-only maker quote. Clamped so it can never cross (contract reverts). */
  async function postQuote(isBid: boolean, price: number, baseAmount: bigint) {
    if (!address) return;
    const b = bookRef.current;
    const bestAsk = b?.asks?.[0]?.price;
    const bestBid = b?.bids?.[0]?.price;
    let p = price;
    if (isBid && bestAsk != null) p = Math.min(p, bestAsk - 1e-5);
    if (!isBid && bestBid != null) p = Math.max(p, bestBid + 1e-5);
    if (p <= 0) return;

    const tick = tickOf(p);
    const token = isBid ? ADDR.eurc : ADDR.usdc;
    const escrow = isBid ? BigInt(Math.ceil(p * Number(baseAmount))) : baseAmount;
    await approveIfNeeded(token, ADDR.book, escrow);

    const hash = await writeContractAsync({
      address: ADDR.book as `0x${string}`,
      abi: bookAbi,
      functionName: "placeOrder",
      args: [isBid, tick, baseAmount],
      chainId: arcTestnet.id,
    });
    say(`${isBid ? "bid" : "ask"} ${fmt(baseAmount, 2)} @ ${p.toFixed(5)} · ${hash.slice(0, 10)}…`, "act");
    setOpenOrders((o) => [{ id: hash, side: isBid ? "bid" : "ask", price: p.toFixed(5) }, ...o].slice(0, 8));
  }

  /** One decision cycle. Exactly one action per tick, so signing stays sane. */
  async function tick() {
    if (busy.current || !address || !client) return;
    const c = cfg.current;
    const sizeAmt = parse(c.size);
    const cap = Number(c.maxCapital);
    if (sizeAmt === 0n) return;

    if (c.deployed + Number(c.size) > cap) {
      say(`max capital ${cap} reached — bot idling`, "info");
      return;
    }

    const px = poolRef.current?.ammPrice;
    if (!px) return;

    busy.current = true;
    try {
      if (c.strategy === "mm") {
        const half = (Number(c.spreadBps) / 10_000) * px * 0.5;
        const b = bookRef.current;
        const mid = b?.bids?.[0] && b?.asks?.[0] ? (b.bids[0].price + b.asks[0].price) / 2 : px;
        // Alternate sides so we build a two-sided quote over consecutive ticks.
        const wantBid = openOrders.filter((o) => o.side === "bid").length <= openOrders.filter((o) => o.side === "ask").length;
        await postQuote(wantBid, wantBid ? mid - half : mid + half, sizeAmt);
      } else if (c.strategy === "grid") {
        // Buy when price sits below the grid mid, sell when above.
        const step = (Number(c.spreadBps) / 10_000) * px;
        const ref = poolRef.current!.ammPrice;
        if (px < ref - step) {
          await routerSwap(true, sizeAmt); // USDC → EURC (buy the dip)
        } else if (px > ref + step) {
          await routerSwap(false, sizeAmt);
        } else {
          say(`price ${px.toFixed(5)} inside grid band — no action`);
          busy.current = false;
          return;
        }
      } else {
        await routerSwap(c.dcaSell, sizeAmt);
      }

      setDeployed((d) => d + Number(c.size));
      errors.current = 0;
      const v = await portfolioValue();
      if (v != null && startValue != null) setPnl(v - startValue);
    } catch (e) {
      const m = e instanceof Error ? e.message : "failed";
      const rejected = /user rejected|denied|User denied/i.test(m);
      say(rejected ? "wallet rejected — bot stopped" : m.split("\n")[0].slice(0, 100), "err");
      if (rejected) {
        setRunning(false);
      } else if (++errors.current >= 3) {
        say("3 consecutive errors — bot stopped", "err");
        setRunning(false);
      }
    } finally {
      busy.current = false;
    }
  }

  // The loop. Restarts only on running/interval change.
  useEffect(() => {
    if (!running) return;
    const ms = Math.max(15, Number(intervalS) || 60) * 1000;
    const id = setInterval(tick, ms);
    void tick();
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, intervalS]);

  async function start() {
    if (!address) return;
    const v = await portfolioValue();
    setStartValue(v);
    setPnl(0);
    setDeployed(0);
    errors.current = 0;
    say(`bot started · ${STRATEGIES.find((s) => s.id === strategy)!.label}`, "info");
    setRunning(true);
  }

  function stop() {
    setRunning(false);
    say("bot stopped", "info");
  }

  const active = STRATEGIES.find((s) => s.id === strategy)!;

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-fg">Trading bot</h2>
        <span
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.1em] ${
            running ? "border-mint/40 bg-mint/10 text-mint" : "border-[color:var(--line)] text-faint"
          }`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${running ? "animate-pulse bg-mint" : "bg-faint"}`} />
          {running ? "running" : "idle"}
        </span>
      </div>

      <p className="mt-1 text-xs leading-relaxed text-faint">
        Automated strategies that run in <span className="text-fg">your browser</span> and trade from{" "}
        <span className="text-fg">your own wallet</span>. Onyx never sees or asks for a private key —
        so every order needs a wallet confirmation, and the bot stops when you close this tab.
      </p>

      <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl border border-[color:var(--line)] bg-black/[0.04] p-1 dark:bg-white/[0.025]">
        {STRATEGIES.map((s) => (
          <button
            key={s.id}
            onClick={() => !running && setStrategy(s.id)}
            disabled={running}
            className={`rounded-[9px] py-1.5 text-[11px] font-medium transition-all duration-300 disabled:opacity-60 ${
              strategy === s.id ? "bg-indigo/20 text-fg" : "text-faint hover:text-muted"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-center text-[11px] text-faint">{active.blurb}</p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Field label="Order size (USDC)" value={size} onChange={setSize} disabled={running} />
        <Field
          label={strategy === "grid" ? "Grid step (bps)" : "Spread (bps)"}
          value={spreadBps}
          onChange={setSpreadBps}
          disabled={running || strategy === "dca"}
        />
        <Field label="Max capital (USDC)" value={maxCapital} onChange={setMaxCapital} disabled={running} />
        <Field label="Interval (sec)" value={intervalS} onChange={setIntervalS} disabled={running} />
      </div>

      {strategy === "dca" && (
        <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl border border-[color:var(--line)] bg-black/[0.04] p-1 dark:bg-white/[0.025]">
          {([true, false] as const).map((s) => (
            <button
              key={String(s)}
              onClick={() => !running && setDcaSell(s)}
              disabled={running}
              className={`rounded-[9px] py-1.5 text-xs font-medium transition-all ${
                dcaSell === s ? "bg-indigo/20 text-fg" : "text-faint hover:text-muted"
              }`}
            >
              Sell {s ? "USDC" : "EURC"}
            </button>
          ))}
        </div>
      )}

      <button
        onClick={running ? stop : start}
        disabled={!address}
        className={`cta mt-4 w-full py-2.5 text-sm font-medium text-white disabled:opacity-25 ${
          running ? "bg-rose/80" : "bg-indigo/80"
        }`}
      >
        {!address ? "Connect wallet" : running ? "Stop bot" : "Start bot"}
      </button>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Stat label="Deployed" value={`${deployed.toFixed(2)}`} sub="USDC" />
        <Stat label="Open quotes" value={String(openOrders.length)} sub="this session" />
        <Stat
          label="P&L"
          value={pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)}`}
          sub="testnet"
          tone={pnl == null ? undefined : pnl >= 0 ? "up" : "down"}
        />
      </div>

      {log.length > 0 && (
        <div className="mt-4">
          <h3 className="text-[10px] uppercase tracking-[0.14em] text-faint">Activity</h3>
          <div className="mt-2 max-h-44 space-y-1 overflow-y-auto">
            {log.map((l, i) => (
              <div key={`${l.t}-${i}`} className="flex gap-2 font-mono text-[11px]">
                <span className="shrink-0 text-faint">
                  {new Date(l.t).toLocaleTimeString("en-US", { hour12: false })}
                </span>
                <span className={l.kind === "err" ? "text-rose" : l.kind === "act" ? "text-mint" : "text-muted"}>
                  {l.msg}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-4 text-center text-[10px] leading-relaxed text-faint">
        Testnet only. Strategies are rule-based, not financial advice — a bot can
        lose money in a trending market. Max capital caps this session&apos;s spend;
        the bot halts on a rejected signature or three consecutive errors.
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className={`inner p-3 ${disabled ? "opacity-60" : ""}`}>
      <span className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        inputMode="decimal"
        className="mt-1 w-full bg-transparent font-mono text-sm tabular text-fg outline-none"
      />
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "up" | "down" }) {
  return (
    <div className="inner p-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</div>
      <div
        className={`mt-1 font-mono text-sm tabular ${
          tone === "up" ? "text-mint" : tone === "down" ? "text-rose" : "text-fg"
        }`}
      >
        {value}
      </div>
      <div className="text-[10px] text-faint">{sub}</div>
    </div>
  );
}
