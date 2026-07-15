"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { Header } from "@/components/Header";
import { Swap } from "@/components/Swap";
import { BookLadder } from "@/components/BookLadder";
import { LimitPanel } from "@/components/LimitPanel";
import { TwapPanel } from "@/components/TwapPanel";
import { Rise, Stagger } from "@/components/Reveal";
import { usePool } from "@/lib/useBook";
import { fmt } from "@/lib/contracts";

const EASE = [0.16, 1, 0.3, 1] as const;
const TABS = ["Swap", "Make", "TWAP"] as const;
type Tab = (typeof TABS)[number];

/**
 * Terminal-first layout. The product is the hero: the exchange sits top-left
 * where the eye lands, the pitch stands beside it, the book completes the row.
 */
export default function Page() {
  const { data: pool, error: poolError } = usePool();
  const [tab, setTab] = useState<Tab>("Swap");

  return (
    <>
      <Header />

      <main className="mx-auto max-w-6xl px-6 pt-12 sm:pt-16">
        <Stagger gap={0.08} className="grid items-start gap-6 lg:grid-cols-[1fr_0.92fr]">
          {/* -------- terminal, top-left -------- */}
          <Rise>
            <div className="glass lift p-6">
              <div className="relative mb-6 grid grid-cols-3 gap-1 rounded-xl border border-white/[0.08] bg-white/[0.025] p-1">
                {TABS.map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className="relative rounded-[9px] py-1.5 text-xs font-medium"
                  >
                    {tab === t && (
                      <motion.span
                        layoutId="tab-pill"
                        transition={{ type: "spring", stiffness: 380, damping: 32 }}
                        className="absolute inset-0 rounded-[9px] bg-indigo/[0.22]"
                      />
                    )}
                    <span
                      className={`relative transition-colors duration-300 ease-ease ${
                        tab === t ? "text-fg" : "text-faint hover:text-muted"
                      }`}
                    >
                      {t}
                    </span>
                  </button>
                ))}
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={tab}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.28, ease: EASE }}
                >
                  {tab === "Swap" && <Swap />}
                  {tab === "Make" && <LimitPanel />}
                  {tab === "TWAP" && <TwapPanel />}
                </motion.div>
              </AnimatePresence>
            </div>
          </Rise>

          {/* -------- pitch, top-right -------- */}
          <div className="lg:pt-2">
            <Rise>
              <div className="inline-flex items-center gap-2.5 rounded-full border border-mint/25 bg-mint/[0.06] px-3 py-1.5">
                <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-mint" />
                <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-mint">
                  Live on Arc Testnet
                </span>
              </div>
            </Rise>

            <Rise>
              <h1 className="mt-5 text-[36px] font-semibold leading-[1.06] tracking-[-0.02em] text-fg sm:text-[46px]">
                The order book
                <br />
                <span className="shimmer">Arc made possible.</span>
              </h1>
            </Rise>

            <Rise>
              <p className="mt-5 max-w-md text-sm leading-relaxed text-muted">
                Every other DEX here is a curve. A real limit order book only
                works when finality is sub-second and gas costs a cent — true on
                exactly one chain. Orders sweep the book first, then fall
                through to a rate-adjusted StableSwap for whatever it
                can&apos;t absorb.
              </p>
            </Rise>

            <Rise>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Link
                  href="/docs"
                  className="btn btn-mint inline-flex items-center gap-1.5 bg-fg px-4 py-2 text-[13px] font-medium text-base"
                >
                  How it works
                  <ArrowUpRight size={14} />
                </Link>
                <a
                  href="https://github.com/amankhan321/arc-dex"
                  target="_blank"
                  rel="noreferrer"
                  className="btn inline-flex items-center gap-1.5 border border-white/[0.1] px-4 py-2 text-[13px] text-muted hover:text-fg"
                >
                  Read the contracts
                  <ArrowUpRight size={14} />
                </a>
              </div>
            </Rise>

            <Rise>
              {poolError &&
                (poolError.message.includes("0xec30f4ab") ? (
                  <p className="mt-4 rounded-[12px] border border-yellow-500/30 bg-yellow-500/[0.06] p-3 text-[12px] leading-relaxed text-yellow-500/90">
                    FX oracle is stale, so swaps are paused — that&apos;s the
                    safety design, not an outage: the pool halts rather than
                    price off a dead feed. The order book stays live and LPs
                    can always withdraw. Trading resumes on the next rate
                    update.
                  </p>
                ) : (
                  <p className="mt-4 break-words rounded-[12px] border border-rose/30 bg-rose/[0.06] p-3 font-mono text-[11px] leading-relaxed text-rose">
                    RPC error: {poolError.message.slice(0, 220)}
                  </p>
                ))}
              <div className="mt-8 grid grid-cols-2 gap-3">
                <Stat label="Curve price" value={pool ? pool.ammPrice.toFixed(5) : "—"} sub="EURC per USDC" live />
                <Stat
                  label="LP value"
                  value={pool ? (Number(pool.virtualPrice) / 1e18).toFixed(6) : "—"}
                  sub="virtual price"
                  live
                />
                <Stat label="Pool USDC" value={pool ? fmt(pool.balance0, 2) : "—"} sub="reserve" />
                <Stat label="Pool EURC" value={pool ? fmt(pool.balance1, 2) : "—"} sub="reserve" />
              </div>
            </Rise>
          </div>
        </Stagger>

        {/* -------- the book, full width -------- */}
        <Stagger gap={0.06} className="mt-6">
          <Rise>
            <BookLadder onMake={() => setTab("Make")} />
          </Rise>
        </Stagger>
      </main>
    </>
  );
}

function Stat({
  label,
  value,
  sub,
  live,
}: {
  label: string;
  value: string;
  sub: string;
  live?: boolean;
}) {
  return (
    <div className={`glass lift px-4 py-3 ${live ? "alive" : ""}`}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</div>
      <div className="mt-1.5 font-mono text-base tabular text-fg">{value}</div>
      <div className="text-[10px] text-faint">{sub}</div>
    </div>
  );
}
