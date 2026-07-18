import { Prose, Section } from "@/components/Prose";

export const metadata = { title: "Risk — Onyx" };

export default function Risk() {
  return (
    <Prose
      title="Risk disclosure"
      updated="14 July 2026"
      lede="An honest list of the ways this system can hurt someone. It is written plainly because a risk page that reads like marketing is worse than no risk page."
    >
      <Section heading="It is not audited">
        <p>
          The contracts have a full test suite — unit, fuzz, and invariant
          tests, including a solvency invariant driven across tens of thousands
          of randomised state transitions. That is meaningful evidence and it is
          not a proof. No amount of testing substitutes for an audit, and nobody
          can honestly promise you that unaudited code has no vulnerabilities.
        </p>
      </Section>

      <Section heading="The oracle is the trust assumption">
        <p>
          EURC is pegged to the euro, not the dollar, so the pool needs a
          EUR/USD rate to price correctly. Until a canonical feed exists on Arc,
          that rate is pushed by a single updater address.
        </p>
        <p>
          It is fenced deliberately: a cap of 1% movement per update, a
          five-minute cooldown, and a six-hour staleness window after which the
          pool halts trading rather than quote from a dead feed. LPs can always
          withdraw, even while it is halted. But a compromised updater is still
          the sharpest edge in this system, and pretending otherwise would be
          dishonest.
        </p>
      </Section>

      <Section heading="Impermanent loss">
        <p>
          Providing liquidity is not lending. If EUR/USD moves, the pool
          rebalances against you and you can withdraw less value than you
          deposited, fees notwithstanding.
        </p>
      </Section>

      <Section heading="Thin books slip">
        <p>
          The order book is only as deep as the orders resting in it. A large
          taker order can sweep every level and fall through to the curve at a
          materially worse price. The interface shows you the expected output
          and enforces a floor beneath it — read both before you sign.
        </p>
      </Section>

      <Section heading="Immutability is not safety">
        <p>
          Nobody can rug these contracts, because nobody has a key. That also
          means nobody can patch them. A bug found tomorrow stays there forever,
          and the only remedy is to withdraw and redeploy.
        </p>
      </Section>
    </Prose>
  );
}
