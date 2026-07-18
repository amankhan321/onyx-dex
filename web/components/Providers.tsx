"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider } from "@privy-io/wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { wagmiConfig } from "@/lib/wagmi";
import { arcTestnet } from "@/lib/contracts";

/**
 * Privy wraps wagmi so Google/email login + an embedded wallet sit alongside
 * the extension wallets. If NEXT_PUBLIC_PRIVY_APP_ID is unset (no dashboard
 * account yet), we fall back to plain wagmi so the app still runs with
 * MetaMask/OKX/Rabby — Privy just stays dark until the ID is provided.
 */
const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID;

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(() => new QueryClient());

  if (!PRIVY_APP_ID) {
    // Graceful no-Privy path: extension wallets still work.
    const { WagmiProvider: BaseWagmi } = require("wagmi");
    return (
      <BaseWagmi config={wagmiConfig}>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </BaseWagmi>
    );
  }

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["google", "email", "wallet"],
        appearance: { theme: "dark", accentColor: "#5E6AD2", logo: undefined },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: arcTestnet,
        supportedChains: [arcTestnet],
      }}
    >
      <QueryClientProvider client={qc}>
        <WagmiProvider config={wagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
