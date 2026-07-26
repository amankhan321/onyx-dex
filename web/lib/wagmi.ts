import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { arbitrumSepolia, baseSepolia, sepolia } from "wagmi/chains";
import { arcTestnet } from "./contracts";

const DIRECT = "https://rpc.testnet.arc.network";
const OPTS = { batch: false, retryCount: 2, retryDelay: 400, timeout: 12_000 } as const;

/**
 * THE READ PATH, decided by evidence accumulated over the whole build:
 * server-side calls to the Arc RPC have never failed once (keeper mined six
 * consecutive setRates; every cast from two machines answers instantly), while
 * BROWSER calls drop randomly — quotes, asks, bids failing in different
 * combinations at different times. So browser reads go through our own
 * same-origin /api/rpc proxy, which forwards server-side from Vercel/droplet —
 * the reliable path — with the direct RPC as fallback. SSR reads go direct.
 * Writes go through the connected wallet and never touch this.
 */
const transport =
  typeof window === "undefined"
    ? http(DIRECT, OPTS)
    : fallback([http(`${window.location.origin}/api/rpc`, OPTS), http(DIRECT, OPTS)]);

export const wagmiConfig = createConfig({
  chains: [arcTestnet, baseSepolia, sepolia, arbitrumSepolia],
  connectors: [injected()],
  // Arc keeps the proxy-first transport; CCTP destinations use public RPCs and
  // are only touched when a user claims a bridged transfer there.
  transports: {
    [arcTestnet.id]: transport,
    [baseSepolia.id]: http(),
    [sepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
  },
  ssr: true,
});
