import type { Metadata } from "next";
import { FaucetPanel } from "@/components/FaucetPanel";

/**
 * A linkable faucet page.
 *
 * FaucetPanel was only reachable as a tab on the landing page, so nothing could
 * link to it — including the Mini App, which is exactly where a user with no
 * funds ends up. Onyx does not operate a faucet: this page explains what's
 * needed and points at Circle's.
 */
export const metadata: Metadata = {
  title: "Get testnet funds — Onyx",
  description:
    "Get testnet USDC and EURC on Arc Testnet from Circle's faucet, then trade on Onyx.",
};

export default function FaucetPage() {
  return (
    <main className="mx-auto max-w-xl px-5 py-10">
      <h1 className="font-display text-3xl text-fg">Get testnet funds</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Onyx runs on Arc Testnet. You need <span className="text-fg">USDC</span> — which is
        also the gas token on Arc — and <span className="text-fg">EURC</span> to trade the
        pair.
      </p>

      <div className="glass mt-6 p-6">
        <FaucetPanel />
      </div>

      {/*
        Onyx points at Circle's faucet; it does not run one. Saying so plainly
        matters — we are an independent app built on Arc, not a Circle service,
        and implying otherwise would be a misrepresentation.
      */}
      <p className="mt-6 text-center text-[11px] leading-relaxed text-faint">
        The faucet is operated by Circle. Onyx is an independent application built on Arc and
        is not affiliated with or operated by Circle.
      </p>
    </main>
  );
}
