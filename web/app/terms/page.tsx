import { Prose, Section } from "@/components/Prose";

export const metadata = { title: "Terms — Onyx" };

export default function Terms() {
  return (
    <Prose
      title="Terms of use"
      updated="14 July 2026"
      lede="Onyx is unaudited software on a test network, published as an experiment. Using it means you accept the terms below."
    >
      <Section heading="What Onyx is">
        <p>
          A set of immutable smart contracts deployed to Arc Testnet, and a web
          page that talks to them. We operate no exchange, hold no custody, take
          no fee, and are not a counterparty to any trade. The interface is
          convenience; the contracts are the product, and anyone can call them
          without us.
        </p>
      </Section>

      <Section heading="No warranty">
        <p>
          The software is provided as-is, without warranty of any kind. It has
          not been audited. It may contain bugs that cost you your entire
          balance. Do not deploy it against real funds without a professional
          audit — this is stated in the repository too, and we mean it.
        </p>
      </Section>

      <Section heading="Testnet assets have no value">
        <p>
          Tokens on Arc Testnet are issued freely by a faucet, cannot be
          exchanged for anything, and are worth nothing. Nothing here is an
          offer, a solicitation, or a promise of a future token, airdrop, or
          reward.
        </p>
      </Section>

      <Section heading="You are responsible for your keys">
        <p>
          Transactions on a blockchain are irreversible. We cannot cancel,
          reverse, or refund one. If you lose your private key, sign something
          you did not read, or approve a contract you did not verify, we cannot
          help you and no one else can either.
        </p>
      </Section>

      <Section heading="No admin, which cuts both ways">
        <p>
          The contracts have no owner, no pause switch, and no upgrade path. We
          could not seize your funds if we wanted to. We also cannot rescue them
          if something goes wrong. That is the trade, and it is deliberate.
        </p>
      </Section>

      <Section heading="Eligibility">
        <p>
          Do not use Onyx where doing so would break the law that applies to
          you. You are responsible for knowing what that law is.
        </p>
      </Section>
    </Prose>
  );
}
