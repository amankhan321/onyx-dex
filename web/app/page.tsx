"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowUpRight } from "lucide-react";
import { Header } from "@/components/Header";
import { Swap } from "@/components/Swap";
import { BookLadder } from "@/components/BookLadder";
import { LimitPanel } from "@/components/LimitPanel";
import { TwapPanel } from "@/components/TwapPanel";
import { FaucetPanel } from "@/components/FaucetPanel";
import { TxHistory } from "@/components/TxHistory";
import { Rise, SlideIn, Stagger } from "@/components/Reveal";
import { PanelBoundary } from "@/components/PanelBoundary";
import { CountUp } from "@/components/CountUp";
import { Float } from "@/components/Reveal";
import { usePool } from "@/lib/useBook";
import { fmt } from "@/lib/contracts";

const EASE = [0.16, 1, 0.3, 1] as const;
const TABS = ["Swap", "Make", "TWAP", "Faucet"] as const;
type Tab = (typeof TABS)[number];

/**
 * Terminal-first layout. The product is the hero: the exchange sits top-left
 * where the eye lands, the pitch stands beside it, the book completes the row.
 */
export default function Page() {
  const { data: pool, error: poolError } = usePool();
  const [tab, setTab] = useState<Tab>("Swap");
  const heroRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const el = heroRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { el.classList.add("hero-in"); io.disconnect(); }
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <>
      <Header />

      <main className="mx-auto max-w-6xl px-6 pt-12 sm:pt-16">
        <Stagger gap={0.08} whenInView={false} className="mx-auto flex max-w-xl flex-col gap-10">
          {/* -------- terminal, top-left -------- */}
          <Rise>
            <motion.div
              id="terminal"
              initial={{ opacity: 0, scale: 0.9, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
              className="glass lift focus-halo scroll-mt-24 p-6"
            >
              <div className="relative mb-6 grid grid-cols-4 gap-1 rounded-xl border border-[color:var(--line)] bg-black/[0.03] dark:bg-white/[0.025] p-1">
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

              {/* No AnimatePresence here, deliberately: mode="wait" can strand
                  the incoming tab unmounted if a re-render lands mid-exit — and
                  this page re-renders every few seconds from the book poll. A
                  keyed fade-in gives the same feel with no wedge state. */}
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: EASE }}
              >
                {tab === "Swap" && <Swap />}
                {tab === "Make" && <LimitPanel />}
                {tab === "TWAP" && <TwapPanel />}
                {tab === "Faucet" && <FaucetPanel />}
              </motion.div>
            </motion.div>
          </Rise>

          <Rise>
            {poolError &&
              (poolError.message.includes("0xec30f4ab") ? (
                <p className="mx-auto mt-2 max-w-xl rounded-[12px] border border-yellow-500/30 bg-yellow-500/[0.06] p-3 text-[12px] leading-relaxed text-yellow-500/90">
                  FX oracle is stale, so swaps are paused — that&apos;s the
                  safety design, not an outage. The order book stays live and
                  LPs can always withdraw. Trading resumes on the next rate
                  update.
                </p>
              ) : (
                <p className="mx-auto mt-2 max-w-xl break-words rounded-[12px] border border-rose/30 bg-rose/[0.06] p-3 font-mono text-[11px] leading-relaxed text-rose">
                  RPC error: {poolError.message.slice(0, 220)}
                </p>
              ))}
            <div className="mx-auto mt-2 grid max-w-xl grid-cols-2 gap-3 text-left sm:grid-cols-4">
              <SlideIn from="left" delay={0}><StatNum label="Curve price" value={pool?.ammPrice} format={(n) => n.toFixed(5)} sub="EURC per USDC" live /></SlideIn>
              <SlideIn from="left" delay={0.08}><StatNum
                label="LP value"
                value={pool ? Number(pool.virtualPrice) / 1e18 : undefined}
                format={(n) => n.toFixed(6)}
                sub="virtual price"
                live
              /></SlideIn>
              <SlideIn from="right" delay={0.08}><StatNum label="Pool USDC" value={pool ? Number(pool.balance0) / 1e6 : undefined} format={(n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} sub="reserve" /></SlideIn>
              <SlideIn from="right" delay={0}><StatNum label="Pool EURC" value={pool ? Number(pool.balance1) / 1e6 : undefined} format={(n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} sub="reserve" /></SlideIn>
            </div>
          </Rise>

          {/* -------- pitch, top-right -------- */}
        </Stagger>

        {/* -------- the book, full width -------- */}
        <Stagger gap={0.06} className="mt-6">
          <SlideIn from="right" distance={70}>
            <BookLadder
              onMake={() => {
                setTab("Make");
                document.getElementById("terminal")?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            />
          </SlideIn>
        </Stagger>

        <Stagger gap={0.08} className="mt-16">
          <Rise>
            <div className="text-center">
              <Rise>
                <Float distance={4} duration={5}>
                  <div className="inline-flex items-center gap-2.5 rounded-full border border-mint/25 bg-mint/[0.06] px-3 py-1.5">
                    <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-mint" />
                    <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-mint">
                      Live on Arc Testnet
                    </span>
                  </div>
                </Float>
              </Rise>
  
              <Rise>
                <h1 ref={heroRef} className="mx-auto mt-5 font-display text-[46px] font-normal leading-[1.02] tracking-[-0.01em] text-fg sm:text-[62px]">
                  <span className="hero-line-a">The order book</span>
                  <br />
                  <span className="hero-line-b shimmer italic">Arc made possible.</span>
                </h1>
              </Rise>
  
              <Rise>
                <p className="mx-auto mt-5 max-w-md text-sm leading-relaxed text-muted">
                  Every other DEX here is a curve. A real limit order book only
                  works when finality is sub-second and gas costs a cent — true on
                  exactly one chain. Orders sweep the book first, then fall
                  through to a rate-adjusted StableSwap for whatever it
                  can&apos;t absorb.
                </p>
              </Rise>
  
              <Rise>
                <Float distance={5} duration={7}>
                <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
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
                </Float>
              </Rise>
  
            </div>
          </Rise>
        </Stagger>
      </main>
    </>
  );
}

function StatNum({
  label,
  value,
  format,
  sub,
  live,
}: {
  label: string;
  value: number | undefined;
  format: (n: number) => string;
  sub: string;
  live?: boolean;
}) {
  return (
    <div className={`glass popup-card px-4 py-3 ${live ? "alive" : ""}`}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</div>
      <div className="stat-value mt-1.5 font-mono text-base tabular text-fg">
        {value == null ? "—" : <CountUp value={value} format={format} />}
      </div>
      <div className="text-[10px] text-faint">{sub}</div>
    </div>
  );
}
