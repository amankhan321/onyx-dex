"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { usePool } from "@/lib/useBook";

export function Header() {
  const { address } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: pool, error: poolError, isLoading: poolLoading } = usePool();

  return (
    <header className="sticky top-0 z-30 border-b border-white/[0.06] bg-base/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <Link href="/" className="group flex items-center gap-2.5">
          <motion.div
            whileHover={{ rotate: 8, scale: 1.08 }}
            transition={{ type: "spring", stiffness: 300, damping: 18 }}
            className="h-[18px] w-[18px] rounded-[6px] bg-gradient-to-br from-indigo to-mint"
          />
          <span className="text-sm font-medium tracking-tight text-fg">
            ArcBook
          </span>
          <span className="hidden rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-muted sm:block">
            Arc Testnet
          </span>
        </Link>

        <nav className="hidden items-center gap-6 md:flex">
          <NavLink href="/docs">How it works</NavLink>
          <NavLink href="https://github.com/amankhan321/arc-dex">GitHub</NavLink>
        </nav>

        <div className="flex items-center gap-4">
          {/* One glance = full diagnosis. Green: reads flowing. Amber: loading.
              Red: the RPC path is down — hover for the actual error. */}
          <span
            title={
              poolError
                ? `RPC error: ${poolError.message.slice(0, 200)}`
                : pool
                  ? "RPC connected"
                  : "RPC connecting…"
            }
            className={`h-1.5 w-1.5 rounded-full ${
              poolError ? "bg-rose" : pool ? "bg-mint" : "bg-yellow-500"
            }`}
          />
          {pool && (
            <span className="hidden font-mono text-[11px] tabular text-faint lg:block">
              vprice{" "}
              <span className="text-muted">
                {(Number(pool.virtualPrice) / 1e18).toFixed(6)}
              </span>
            </span>
          )}
          {/* Multi-wallet extensions can clash over window.ethereum and throw
              before our code runs. Guard the connect click so the failure is a
              readable message, not a silent console error. */}
          {address ? (
            <button
              onClick={() => disconnect()}
              className="btn border border-white/[0.1] px-3 py-1.5 font-mono text-xs tabular text-muted hover:text-fg"
            >
              {address.slice(0, 6)}…{address.slice(-4)}
            </button>
          ) : (
            <button
              onClick={() => {
                try {
                  if (!connectors.length || typeof window === "undefined" || !("ethereum" in window)) {
                    alert("No wallet detected. Install MetaMask (or another injected wallet) and reload.");
                    return;
                  }
                  connect({ connector: connectors[0] });
                } catch {
                  alert("Your wallet extensions are conflicting over window.ethereum. Disable all but one and reload.");
                }
              }}
              className="btn bg-indigo px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo/90"
            >
              Connect
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="relative text-xs text-muted transition-colors duration-300 ease-ease hover:text-fg"
    >
      {children}
    </Link>
  );
}
