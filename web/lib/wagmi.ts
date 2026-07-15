import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./contracts";

const DIRECT = "https://rpc.testnet.arc.network";

/**
 * THE EVIDENCE, so this doesn't flip-flop again: every server-side caller
 * (keeper, cast from two different machines) reaches the Arc RPC fine; every
 * BROWSER call fails ("RPC Request failed" on eth_call). The RPC blocks
 * browser-origin requests. Reads therefore go through our same-origin
 * /api/rpc proxy — served by this very app on Vercel AND on the droplet —
 * with the direct RPC as a fallback in case some environment allows it.
 * Batching stays OFF everywhere: the RPC also drops batched calls.
 * Writes go through the connected wallet and never touch this transport.
 */
const opts = { retryCount: 3, retryDelay: 400, timeout: 15_000, batch: false } as const;

const transport =
  typeof window === "undefined"
    ? http(DIRECT, opts)
    : fallback([
        http(`${window.location.origin}/api/rpc`, opts),
        http(DIRECT, opts),
      ]);

export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: { [arcTestnet.id]: transport },
  ssr: true,
});
