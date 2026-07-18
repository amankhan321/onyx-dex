import { createConfig, http } from "wagmi";
import { coinbaseWallet, injected } from "wagmi/connectors";
import { arcTestnet } from "./contracts";

/**
 * Connectors:
 *  - injected(): MetaMask, OKX, Rabby, Phantom, any EIP-1193/6963 extension.
 *    Modern wallets announce themselves via EIP-6963, so wagmi lists each
 *    installed one separately — OKX and Rabby appear by name automatically
 *    when present, no per-wallet code needed.
 *  - coinbaseWallet(): Coinbase Wallet + its Smart Wallet (passkey) option.
 *    NOTE: Smart Wallet mints ERC-4337 accounts on Base and needs a bundler +
 *    EntryPoint on the target chain; on Arc testnet that path may not resolve
 *    until Arc ships 4337 infra. The connector is wired so it lights up the
 *    moment it can; today it reliably covers the Coinbase extension.
 *
 * Reads go straight to the Arc RPC; writes go through whichever wallet connects.
 */
export const wagmiConfig = createConfig({
  chains: [arcTestnet],
  connectors: [
    injected(),
    coinbaseWallet({ appName: "ArcBook", preference: "all" }),
  ],
  transports: {
    [arcTestnet.id]: http("https://rpc.testnet.arc.network"),
  },
  ssr: true,
});
