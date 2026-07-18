"use client";

import { useState } from "react";
import { useConnect } from "wagmi";
import { usePrivy } from "@privy-io/react-auth";

/**
 * Connect menu. Two paths:
 *  - Google / email → Privy login (creates an embedded wallet). Only rendered
 *    when a Privy App ID is configured.
 *  - Extension wallets (MetaMask / OKX / Rabby / Phantom) via wagmi connectors,
 *    each detected by name through EIP-6963.
 */
export function ConnectMenu() {
  const { connect, connectors, isPending } = useConnect();
  const [open, setOpen] = useState(false);

  // usePrivy throws if no PrivyProvider is mounted; guard it.
  let privyLogin: (() => void) | null = null;
  let privyReady = false;
  try {
    const p = usePrivy();
    privyLogin = p.login;
    privyReady = p.ready && !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  } catch {
    privyLogin = null;
  }

  const seen = new Set<string>();
  const list = connectors.filter((c) => {
    if (seen.has(c.name) || c.name.toLowerCase().includes("privy")) return false;
    seen.add(c.name);
    return true;
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={isPending}
        className="cta bg-indigo/80 px-4 py-1.5 text-xs font-medium text-white"
      >
        Connect<span className="cta-arrow">→</span>
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-56 overflow-hidden rounded-xl border border-[color:var(--line)] bg-raise shadow-xl">
          {privyReady && privyLogin && (
            <>
              <button
                onClick={() => {
                  privyLogin!();
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs font-medium text-fg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white text-[10px] font-bold text-[#4285F4]">
                  G
                </span>
                Continue with Google / Email
              </button>
              <div className="border-t border-[color:var(--line)]" />
            </>
          )}

          {list.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted">
              No extension wallet found. Install MetaMask, OKX, or Rabby — or use
              Google above.
            </div>
          ) : (
            list.map((c) => (
              <button
                key={c.uid}
                onClick={() => {
                  connect({ connector: c });
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-xs text-fg transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              >
                {c.icon && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.icon} alt="" className="h-4 w-4 rounded" />
                )}
                {c.name === "Injected" ? "Browser Wallet" : c.name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
