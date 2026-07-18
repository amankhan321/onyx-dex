"use client";

import { useEffect, useRef } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { arcTestnet } from "@/lib/contracts";

/**
 * When a wallet connects on the wrong network, get it onto Arc with no manual
 * steps: try switchChain first; if the wallet doesn't know Arc yet it throws
 * 4902, so we fall back to wallet_addEthereumChain (which adds AND switches in
 * one prompt). Runs once per connection, and never nags — if the user declines,
 * we don't loop.
 */
export function AutoChain() {
  const { isConnected, chainId, connector } = useAccount();
  const { switchChain } = useSwitchChain();
  const tried = useRef(false);

  useEffect(() => {
    if (!isConnected) {
      tried.current = false; // reset for the next connection
      return;
    }
    if (chainId === arcTestnet.id || tried.current) return;
    tried.current = true;

    (async () => {
      try {
        // Preferred path — wagmi handles add-if-needed on most modern wallets.
        switchChain({ chainId: arcTestnet.id });
      } catch {
        // Fallback: raw wallet_addEthereumChain, which adds + switches together.
        try {
          const provider = (await connector?.getProvider()) as
            | { request: (a: unknown) => Promise<unknown> }
            | undefined;
          await provider?.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: `0x${arcTestnet.id.toString(16)}`,
                chainName: "Arc Testnet",
                nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
                rpcUrls: ["https://rpc.testnet.arc.network"],
                blockExplorerUrls: ["https://testnet.arcscan.app"],
              },
            ],
          });
        } catch {
          /* user declined — leave them be, the RPC-status dot shows the state */
        }
      }
    })();
  }, [isConnected, chainId, connector, switchChain]);

  return null;
}
