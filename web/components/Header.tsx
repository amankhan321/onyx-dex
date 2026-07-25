"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useAccount, useBalance, useConnect, useDisconnect } from "wagmi";
import { ThemeToggle } from "./ThemeToggle";
import { ConnectMenu } from "./ConnectMenu";
import { arcTestnet } from "@/lib/contracts";
import { usePool } from "@/lib/useBook";

export function Header() {
  const { address } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: pool, error: poolError, isLoading: poolLoading } = usePool();
  // Native USDC balance (USDC is the gas token on Arc). Refreshes on new blocks.
  const { data: bal } = useBalance({ address, chainId: arcTestnet.id, query: { enabled: !!address } });

  return (
    <header className="sticky top-0 z-30 border-b border-[color:var(--line)] bg-base backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
        <Link href="/" className="group logo-3d">
          <motion.div
            whileHover={{ rotate: 8, scale: 1.08 }}
            transition={{ type: "spring", stiffness: 300, damping: 18 }}
            className="logo-mark-3d relative h-[18px] w-[18px] rounded-[6px] bg-gradient-to-br from-indigo to-mint"
          />
          <span className="logo-word-3d text-sm font-medium tracking-tight text-fg">
            Onyx
          </span>
          <span className="hidden rounded-full border border-[color:var(--line)] px-2 py-0.5 text-[10px] text-muted sm:block">
            Arc Testnet
          </span>
        </Link>

        <div className="flex items-center gap-3">
          <ThemeToggle />
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
          {address && bal && (
            <span className="hidden rounded-lg border border-[color:var(--line)] px-2.5 py-1.5 font-mono text-[11px] tabular text-fg sm:inline">
              {Number(bal.formatted).toLocaleString("en-US", { maximumFractionDigits: 2 })} {bal.symbol}
            </span>
          )}
          {address ? (
            <button
              onClick={() => disconnect()}
              className="btn border border-[color:var(--line)] px-3 py-1.5 font-mono text-xs tabular text-muted hover:text-fg"
            >
              {address.slice(0, 6)}…{address.slice(-4)}
            </button>
          ) : (
            <ConnectMenu />
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
