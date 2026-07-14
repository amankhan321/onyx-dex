"use client";

import { useAccount, useConnect, useDisconnect } from "wagmi";
import { usePool } from "@/lib/useBook";

export function Header() {
  const { address } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: pool } = usePool();

  return (
    <header className="relative z-10 flex items-center justify-between border-b border-line px-6 py-4">
      <div className="flex items-center gap-3">
        <div className="h-5 w-5 rounded-[6px] bg-gradient-to-br from-accent to-bid" />
        <span className="text-sm font-medium tracking-tight text-white">
          ArcBook
        </span>
        <span className="hidden rounded-full border border-line px-2 py-0.5 text-[10px] text-muted sm:block">
          Arc Testnet
        </span>
      </div>

      <div className="flex items-center gap-4">
        {pool && (
          <span className="hidden text-[11px] tabular text-muted md:block">
            virtual price{" "}
            <span className="text-soft">
              {(Number(pool.virtualPrice) / 1e18).toFixed(6)}
            </span>
          </span>
        )}
        {address ? (
          <button
            onClick={() => disconnect()}
            className="rounded-lg hairline px-3 py-1.5 text-xs tabular text-soft transition-colors hover:border-accent"
          >
            {address.slice(0, 6)}…{address.slice(-4)}
          </button>
        ) : (
          <button
            onClick={() => connect({ connector: connectors[0] })}
            className="rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-ink"
          >
            Connect
          </button>
        )}
      </div>
    </header>
  );
}
