"use client";

import { motion } from "framer-motion";
import { Header } from "@/components/Header";
import { Swap } from "@/components/Swap";
import { BookLadder } from "@/components/BookLadder";
import { LimitPanel } from "@/components/LimitPanel";
import { usePool } from "@/lib/useBook";
import { fmt } from "@/lib/contracts";

const rise = {
  hidden: { opacity: 0, y: 12 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.06 * i, duration: 0.5, ease: [0.16, 1, 0.3, 1] as const },
  }),
};

export default function Page() {
  const { data: pool } = usePool();

  return (
    <div className="relative">
      <Header />

      <main className="relative z-10 mx-auto max-w-6xl px-6 pb-24 pt-14">
        <motion.div initial="hidden" animate="show" custom={0} variants={rise}>
          <h1 className="max-w-2xl text-3xl font-medium leading-[1.15] tracking-[-0.02em] text-white sm:text-[40px]">
            The first on-chain order book on Arc.
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-soft">
            Every other DEX here is a curve. A real central limit order book only
            works when finality is sub-second and gas is a cent — which is true
            on exactly one chain. Orders route through the book first, then fall
            through to a rate-adjusted StableSwap for whatever the book can&apos;t
            absorb.
          </p>
        </motion.div>

        <motion.div
          initial="hidden"
          animate="show"
          custom={1}
          variants={rise}
          className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4"
        >
          <Stat
            label="Curve price"
            value={pool ? pool.ammPrice.toFixed(5) : "—"}
            sub="EURC per USDC"
          />
          <Stat
            label="Pool USDC"
            value={pool ? fmt(pool.balance0, 2) : "—"}
            sub="reserve"
          />
          <Stat
            label="Pool EURC"
            value={pool ? fmt(pool.balance1, 2) : "—"}
            sub="reserve"
          />
          <Stat
            label="LP value"
            value={pool ? (Number(pool.virtualPrice) / 1e18).toFixed(6) : "—"}
            sub="virtual price"
          />
        </motion.div>

        <div className="mt-8 grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
          <motion.div initial="hidden" animate="show" custom={2} variants={rise}>
            <Swap />
          </motion.div>

          <motion.div
            initial="hidden"
            animate="show"
            custom={3}
            variants={rise}
            className="space-y-5"
          >
            <BookLadder />
            <LimitPanel />
          </motion.div>
        </div>

        <motion.p
          initial="hidden"
          animate="show"
          custom={4}
          variants={rise}
          className="mt-12 max-w-2xl text-[11px] leading-relaxed text-[#4A505B]"
        >
          Testnet only, unaudited. No admin keys exist anywhere in the system —
          no owner, no pause, no upgrade, no rescue. EURC is euro-pegged, not a
          dollar, so the pool runs a rate-adjusted invariant rather than
          assuming par.
        </motion.p>
      </main>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl hairline bg-panel px-4 py-3">
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
        {label}
      </div>
      <div className="mt-1.5 text-lg tabular text-white">{value}</div>
      <div className="text-[10px] text-[#4A505B]">{sub}</div>
    </div>
  );
}
