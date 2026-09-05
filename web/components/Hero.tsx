"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Rise, Stagger } from "./Reveal";

export function Hero() {
  return (
    <Stagger gap={0.08}>
      <Rise>
        <div className="inline-flex items-center gap-2.5 rounded-full border border-mint/25 bg-mint/[0.06] px-3 py-1.5">
          <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-mint" />
          <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-mint">
            Live on Arc Testnet
          </span>
        </div>
      </Rise>

      <Rise>
        <h1 className="mt-7 max-w-4xl text-[42px] font-semibold leading-[1.04] tracking-[-0.02em] text-fg sm:text-[56px] lg:text-[72px]">
          The order book,
          <br />
          <span className="shimmer">made practical on Arc.</span>
        </h1>
      </Rise>

      <Rise>
        <p className="mt-7 max-w-xl text-[15px] leading-relaxed text-muted">
          An onchain limit order book for stablecoin FX. Makers quote and cancel
          continuously, which becomes economical with sub-second finality and
          ~$0.01 gas. Each order sweeps the resting book first, then settles the
          remainder through a rate-adjusted StableSwap in the same transaction.
        </p>
      </Rise>

      <Rise>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link
            href="/docs"
            className="btn btn-mint inline-flex items-center gap-1.5 bg-fg px-5 py-2.5 text-[13px] font-medium text-base"
          >
            How it works
            <ArrowUpRight size={14} />
          </Link>
          <a
            href="https://github.com/amankhan321/arc-dex"
            target="_blank"
            rel="noreferrer"
            className="btn inline-flex items-center gap-1.5 border border-[color:var(--line)] px-5 py-2.5 text-[13px] text-muted hover:text-fg"
          >
            Read the contracts
            <ArrowUpRight size={14} />
          </a>
        </div>
      </Rise>
    </Stagger>
  );
}
