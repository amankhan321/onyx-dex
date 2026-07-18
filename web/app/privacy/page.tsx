import { Prose, Section } from "@/components/Prose";

export const metadata = { title: "Privacy — Onyx" };

export default function Privacy() {
  return (
    <Prose
      title="Privacy"
      updated="14 July 2026"
      lede="Onyx has no backend. There is no server that belongs to us, no database, no account, and no login. That makes this policy unusually short, and we would rather it be short and true than long and reassuring."
    >
      <Section heading="What we collect">
        <p>
          Nothing. Onyx is a static web page. It holds no user records, sets
          no tracking cookies, and runs no analytics. We cannot identify you,
          because we never receive anything that would let us.
        </p>
      </Section>

      <Section heading="Who does see something">
        <p>
          Being honest about this matters more than claiming total privacy,
          because three parties are unavoidably involved:
        </p>
        <p>
          <strong className="text-fg">The Arc RPC endpoint.</strong> Your
          browser reads prices and submits transactions by talking directly to{" "}
          <code className="text-fg">rpc.testnet.arc.network</code>, operated by
          Circle. Like any web request, that reveals your IP address and the
          calls you make. We do not proxy it and we never see it.
        </p>
        <p>
          <strong className="text-fg">Your wallet.</strong> MetaMask, or
          whatever you connect, has its own privacy policy. Read it.
        </p>
        <p>
          <strong className="text-fg">Our host.</strong> The page is served from
          a CDN, which keeps standard access logs (IP, user agent, timestamp) as
          any web server does. We do not query them and they are not linked to
          anything else.
        </p>
      </Section>

      <Section heading="The blockchain remembers">
        <p>
          Every order you place, cancel, or fill is written permanently to a
          public ledger, tied to your wallet address, and visible to anyone
          forever. This is not something we can delete for you and not something
          any policy can undo. If a trade would embarrass you, do not make it
          from an address that is linked to your identity.
        </p>
      </Section>

      <Section heading="Your rights">
        <p>
          Rights of access, correction, and erasure apply to personal data a
          controller holds. We hold none, so there is nothing to disclose,
          correct, or delete. Disconnecting your wallet and closing the tab ends
          our relationship entirely.
        </p>
      </Section>

      <Section heading="Contact">
        <p>
          Questions go to the GitHub repository. This document describes a
          testnet experiment, not a regulated financial service, and it is not
          legal advice.
        </p>
      </Section>
    </Prose>
  );
}
