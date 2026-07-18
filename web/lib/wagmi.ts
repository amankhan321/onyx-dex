import { createConfig } from "@privy-io/wagmi";
import { http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arcTestnet } from "./contracts";

/**
 * wagmi config for Privy. injected() still covers MetaMask / OKX / Rabby /
 * Phantom via EIP-6963; Privy layers Google/email login + an embedded wallet
 * on top through its provider (see Providers.tsx). Reads hit the Arc RPC
 * directly; writes go through whichever wallet — extension or embedded — is
 * connected.
 */
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [injected()],
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
  },
});
