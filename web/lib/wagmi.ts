import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./contracts";

/**
 * injected() covers every browser-extension wallet — MetaMask, OKX, Rabby,
 * Phantom — via EIP-6963, which announces each installed wallet separately so
 * they appear by name with no per-wallet code. Reads hit the Arc RPC directly;
 * writes go through whichever wallet connects.
 *
 * (Google/email login via Privy was attempted and reverted: @privy-io/wagmi
 * pins viem to exactly 2.52.0, which conflicts with the version the rest of the
 * stack builds against. Revisit post-launch as a deliberate upgrade, not a
 * last-minute add.)
 */
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
  },
  ssr: true,
});
