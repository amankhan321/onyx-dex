"use client";

import { useState } from "react";
import { useConnect } from "wagmi";

/**
 * Lists every detected extension wallet by name (MetaMask, OKX, Rabby,
 * Phantom …). EIP-6963 means each installed wallet is its own entry, so we
 * render whatever the browser actually has rather than a hardcoded list.
 */
export function ConnectMenu() {
  const { connect, connectors, isPending } = useConnect();
  const [open, setOpen] = useState(false);

  const seen = new Set<string>();
  const list = connectors.filter((c) => {
    if (seen.has(c.name)) return false;
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
        <div className="absolute right-0 z-40 mt-2 w-52 overflow-hidden rounded-xl border border-[color:var(--line)] bg-raise shadow-xl">
          {list.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted">
              No wallet detected. Install MetaMask, OKX, or Rabby and reload.
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
