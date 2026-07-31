import { createConfig, fallback, http } from "wagmi";
import { dedupedTransport } from "./rpcTransport";
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
/**
 * Browser reads go through the same-origin proxy, now behind a de-duplicating
 * transport with 429 backoff — one landing-page load was firing 19 POSTs, six
 * of which were rate-limited. SSR still goes direct.
 */
const transport =
  typeof window === "undefined"
    ? http(DIRECT, OPTS)
    : fallback([
        dedupedTransport(`${window.location.origin}/api/rpc`),
        http(DIRECT, OPTS),
      ]);

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
