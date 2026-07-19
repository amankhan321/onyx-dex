"use client";

import { useState } from "react";
import { useAccount } from "wagmi";
import { ExternalLink, Copy, Check } from "lucide-react";

/**
 * In-app faucet helper. We do NOT proxy Arc's faucet — that's their
 * rate-limited, captcha-guarded infra and scripting it would be fragile and
 * poor form. Instead we make the official faucet one honest tap away: explain
 * what's needed, copy the address, deep-link out. Onyx stays clearly an
 * independent app pointing users to Circle's real faucet.
 */
export function FaucetPanel() {
  const { address } = useAccount();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <h2 className="text-sm font-medium text-fg">Get testnet funds</h2>
      <p className="mt-1 text-xs leading-relaxed text-faint">
        Onyx runs on Arc testnet. You need <span className="text-fg">USDC</span> (Arc&apos;s
        gas token, also one side of the pair) and <span className="text-fg">EURC</span> (the
        other side) to trade. Grab both from Circle&apos;s official faucet — it opens in a new
        tab, you stay here.
      </p>

      {address && (
        <div className="inner mt-4 flex items-center justify-between p-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-[0.14em] text-faint">Your address</div>
            <div className="truncate font-mono text-xs text-fg">{address}</div>
          </div>
          <button
            onClick={copy}
            className="btn ml-2 shrink-0 rounded-lg border border-[color:var(--line)] px-2.5 py-1.5 text-[11px] text-muted hover:text-fg"
          >
            {copied ? <Check size={12} className="text-mint" /> : <Copy size={12} />}
          </button>
        </div>
      )}

      <a
        href="https://faucet.circle.com/"
        target="_blank"
        rel="noreferrer"
        className="cta mt-4 flex w-full items-center justify-center gap-2 bg-indigo/80 py-2.5 text-sm font-medium text-white"
      >
        Open Circle faucet
        <ExternalLink size={14} />
      </a>

      <div className="mt-3 space-y-1.5 text-[11px] text-faint">
        <p>1. Copy your address above.</p>
        <p>2. On the faucet, choose <span className="text-muted">Arc Testnet</span>, paste it, request USDC and EURC.</p>
        <p>3. Come back — your balance updates automatically once the drip lands.</p>
      </div>
    </div>
  );
}
