import { Prose, Section } from "@/components/Prose";
import { ADDR } from "@/lib/contracts";

export const metadata = { title: "How it works — Onyx" };

export default function Docs() {
  return (
    <Prose
      title="How it works"
      lede="Onyx is an onchain limit order book for stablecoin FX, with a rate-adjusted StableSwap underneath it. Here is how the two fit together."
    >
      <Section heading="Why order books are hard onchain">
        <p>
          A central limit order book needs makers to quote and pull constantly.
          Where each of those actions costs real money and lands twelve seconds
          later, a maker is exposed for the whole interval and the economics do
          not work. That constraint is the reason automated market makers became
          the default design.
        </p>
        <p>
          Arc has sub-second deterministic finality and flat one-cent gas, which
          makes continuous quoting and cancelling economical.
        </p>
      </Section>

      <Section heading="Pricing a genuine FX pair">
        <p>
          Curve&apos;s StableSwap invariant assumes the two coins trade at par —
          the assumption is baked into the maths.
        </p>
        <p>
          EURC is euro-pegged, so it does not trade at 1.00 USDC. Feeding a
          genuine FX pair into a 1:1 curve concentrates liquidity around a peg
          that does not hold, and arbitrageurs pull it toward par.
        </p>
        <p>
          Onyx converts EURC into USDC terms through a rate provider{" "}
          <em>before</em> the invariant ever sees it, so the 1:1 assumption is
          actually true. Ask the pool to price one USDC and it answers ~0.925,
          not ~0.999.
        </p>
      </Section>

      <Section heading="Hybrid routing">
        <p>
          The Quoter reads the resting book and the curve, and finds the split
          that maximises your output. It is not a heuristic: output from the book
          is concave in size (levels fill best-price-first) and output from the
          curve is concave by construction, so their sum is unimodal and a
          ternary search converges on the true optimum.
        </p>
        <p>
          The Router then sweeps the book and drops the remainder into the pool
          in a single transaction, under one slippage bound. If the book fills
          less than expected, the leftover falls through to the curve rather
          than stranding.
        </p>
      </Section>

      <Section heading="Reentrancy, structurally">
        <p>
          The matching loop makes zero external calls. Fills credit an internal
          balance and makers withdraw separately, so there is no callback for a
          hostile maker to reenter from. It is not guarded against reentrancy so
          much as it has nowhere to reenter.
        </p>
      </Section>

      <Section heading="Fees go to liquidity, not to us">
        <p>
          The book&apos;s taker fee accrues in the contract, and anyone may call{" "}
          <code className="text-fg">flushFees()</code>, which donates it into the
          StableSwap pool and raises its virtual price. The book pays the
          liquidity that backstops it. No treasury, no cut.
        </p>
      </Section>

      <Section heading="Deployed contracts">
        <div className="mt-1 space-y-1.5 font-mono text-[11px]">
          {(
            [
              ["Router", ADDR.router],
              ["OrderBook", ADDR.book],
              ["StableSwap", ADDR.pool],
              ["Quoter", ADDR.quoter],
              ["TwapExecutor", ADDR.twap],
              ["RateProvider", ADDR.rateProvider],
            ] as const
          ).map(([name, addr]) => (
            <div key={name} className="flex items-center justify-between gap-4">
              <span className="text-faint">{name}</span>
              <a
                href={`https://testnet.arcscan.app/address/${addr}`}
                target="_blank"
                rel="noreferrer"
                className="truncate text-muted transition-colors duration-300 ease-ease hover:text-indigo"
              >
                {addr}
              </a>
            </div>
          ))}
        </div>
      </Section>
    </Prose>
  );
}
