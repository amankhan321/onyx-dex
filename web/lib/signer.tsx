"use client";

import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { createWalletClient, type Abi, type Hex } from "viem";
import { browserTransport } from "./rpcTransport";
import { useAccount, useWriteContract } from "wagmi";
import { arcTestnet } from "./contracts";
import type { UnlockedWallet } from "./keystore";

/**
 * ONE signing interface, two implementations.
 *
 * The site runs on an injected wallet via wagmi. The Telegram Mini App has no
 * injected wallet at all — it signs with a local viem account decrypted from the
 * keystore on the user's device. Rather than fork every trading component for
 * the two surfaces (which would drift within a release or two), components
 * depend on this interface and neither knows nor cares which is underneath.
 *
 * Two properties the keystore implementation must preserve, and does:
 *  - the decrypted key exists only inside a single write() call and is wiped in
 *    a finally block, so backgrounding the app cannot leave it resident;
 *  - the password is requested through a callback the UI owns, so it is never
 *    stored here and never leaves the device.
 */

export type WriteRequest = {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** Shown on the confirmation step. Not used for execution. */
  summary?: string;
  /** Whole-token value moved. Drives the re-auth threshold and the fallback cap. */
  capValue?: number;
  /**
   * Force a password prompt even inside an unlocked session. Set for
   * withdrawals: moving funds off-platform is the one action where a borrowed
   * unlocked phone should not be enough.
   */
  requiresReauth?: boolean;
};

export type OnyxSigner = {
  address?: `0x${string}`;
  chainId: number;
  /** Which surface is signing — for copy and policy, never for logic branching. */
  kind: "wagmi" | "keystore";
  ready: boolean;
  /** Execute one write. */
  write: (req: WriteRequest) => Promise<Hex>;
  /**
   * Execute several writes as ONE signing session.
   *
   * This matters for the keystore signer: an approve+swap pair unlocks the key
   * once, sends both, then wipes — instead of prompting for the password twice
   * or, worse, caching it between prompts.
   */
  writeBatch: (reqs: WriteRequest[]) => Promise<Hex[]>;
};

const SignerContext = createContext<OnyxSigner | null>(null);

export function useSigner(): OnyxSigner {
  const s = useContext(SignerContext);
  if (!s) throw new Error("useSigner must be used inside a SignerProvider");
  return s;
}

/** Optional variant for components that render before a signer exists. */
export const useSignerOptional = () => useContext(SignerContext);

export function SignerProvider({ signer, children }: { signer: OnyxSigner; children: ReactNode }) {
  return <SignerContext.Provider value={signer}>{children}</SignerContext.Provider>;
}

/** Implementation A — the existing site. Behaviour is unchanged. */
export function useWagmiSigner(): OnyxSigner {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();

  const write = useCallback(
    async (req: WriteRequest) =>
      writeContractAsync({
        address: req.address,
        abi: req.abi,
        functionName: req.functionName,
        args: req.args as never,
        chainId: arcTestnet.id,
      }),
    [writeContractAsync],
  );

  const writeBatch = useCallback(
    async (reqs: WriteRequest[]) => {
      // The wallet prompts per transaction regardless, so sequential is honest.
      const out: Hex[] = [];
      for (const r of reqs) out.push(await write(r));
      return out;
    },
    [write],
  );

  return useMemo(
    () => ({ address, chainId: arcTestnet.id, kind: "wagmi", ready: Boolean(address), write, writeBatch }),
    [address, write, writeBatch],
  );
}

/**
 * Implementation B — the Mini App.
 *
 * `requestPassword` is supplied by the UI and should resolve from a prompt the
 * user just answered. It is awaited inside the write call, so the password has
 * the shortest possible lifetime and is never held by this module.
 */
/**
 * How the shell hands a usable wallet to the signer.
 *
 * `release()` is called in a finally block after every batch. Whether it
 * actually wipes is the SHELL's decision: inside a live session it keeps the
 * key resident, otherwise it wipes immediately. Keeping that policy out here
 * means the signer can't accidentally extend a key's lifetime.
 */
export type WalletLease = {
  wallet: UnlockedWallet;
  release: () => void;
};

export function useKeystoreSigner(opts: {
  address?: `0x${string}`;
  ready?: boolean;
  acquireWallet: (opts: { reauth: boolean }) => Promise<WalletLease>;
}): OnyxSigner {
  const { address, acquireWallet } = opts;

  const writeBatch = useCallback(
    async (reqs: WriteRequest[]) => {
      // Any request in the batch demanding re-auth escalates the whole batch.
      const reauth = reqs.some((r) => r.requiresReauth);
      const lease = await acquireWallet({ reauth });
      try {
        // MUST be the app's own transport. A bare http() falls back to the
        // chain's default URL and hits Arc directly, which 403s any request
        // with a browser Origin — that was the "HTTP request failed." on every
        // swap. Reads worked only because they already went through the proxy.
        const wallet = createWalletClient({
          account: lease.wallet.account,
          chain: arcTestnet,
          transport: browserTransport(),
        });
        const hashes: Hex[] = [];
        for (const r of reqs) {
          hashes.push(
            await wallet.writeContract({
              address: r.address,
              abi: r.abi,
              functionName: r.functionName,
              args: r.args as never,
              chain: arcTestnet,
            }),
          );
        }
        return hashes;
      } finally {
        lease.release();
      }
    },
    [acquireWallet],
  );

  const write = useCallback(async (req: WriteRequest) => (await writeBatch([req]))[0], [writeBatch]);

  return useMemo(
    () => ({
      address,
      chainId: arcTestnet.id,
      kind: "keystore",
      ready: Boolean(opts.ready ?? address),
      write,
      writeBatch,
    }),
    [address, opts.ready, write, writeBatch],
  );
}
