import Link from "next/link";
import { ADDR } from "@/lib/contracts";

const EXPLORER = "https://testnet.arcscan.app/address";

export function Footer() {
  return (
    <footer className="mt-24 border-t border-[color:var(--line)] px-6 py-10">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-xs">
          <div className="flex items-center gap-2.5">
            <div className="h-4 w-4 rounded-[5px] bg-gradient-to-br from-indigo to-mint" />
            <span className="text-sm font-medium text-fg">Onyx</span>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-faint">
            Onyx — an on-chain order book. Hybrid CLOB + rate-adjusted
            StableSwap for stablecoin FX. Built on Arc.
          </p>
        </div>

        <div className="flex gap-12">
          <Col title="Protocol">
            <A href="/docs">How it works</A>
            <A href="https://github.com/amankhan321/arc-dex">Source</A>
            <A href={`${EXPLORER}/${ADDR.router}`}>Router</A>
            <A href={`${EXPLORER}/${ADDR.book}`}>Order book</A>
          </Col>
          <Col title="Legal">
            <A href="/privacy">Privacy</A>
            <A href="/terms">Terms</A>
            <A href="/risk">Risk disclosure</A>
          </Col>
        </div>
      </div>
    </footer>
  );
}

function Col({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.16em] text-faint">
        {title}
      </div>
      <div className="mt-3 flex flex-col gap-2">{children}</div>
    </div>
  );
}

function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="text-xs text-muted transition-colors duration-300 ease-ease hover:text-fg"
    >
      {children}
    </Link>
  );
}
