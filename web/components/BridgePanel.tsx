"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useSwitchChain, useWriteContract } from "wagmi";
import { ArrowRight, ExternalLink, Loader2 } from "lucide-react";
import {
  ARC_DOMAIN,
  CCTP,
  DESTINATIONS,
  STANDARD_FINALITY_THRESHOLD,
  STANDARD_MAX_FEE,
  messageTransmitterAbi,
  toBytes32,
  tokenMessengerAbi,
  type Destination,
  type PendingTransfer,
} from "@/lib/cctp";
import { ADDR, arcTestnet, erc20Abi, parse } from "@/lib/contracts";

/**
 * CCTP bridge — native USDC out of Arc via Circle's burn-and-mint protocol.
 *
 * Three steps, and the third is the one that matters: burn on Arc, wait for
 * Circle's attestation, then mint on the destination. Between burn and mint the
 * USDC exists nowhere, so EVERY transfer is persisted to localStorage the
 * instant the burn lands. If the user closes the tab, reloads, or the
 * attestation is slow, the transfer reappears in "Pending transfers" and can
 * always be completed — attestations never expire. Losing that state is how
 * bridges lose people's money.
 */
const KEY = (addr: string) => `onyx-cctp-${addr.toLowerCase()}`;

export function BridgePanel() {
  const { address, chainId } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();

  const [dest, setDest] = useState<Destination>(DESTINATIONS[0]);
  const [amount, setAmount] = useState("1");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingTransfer[]>([]);

  const load = useCallback(() => {
    if (!address) return setPending([]);
    try {
      setPending(JSON.parse(localStorage.getItem(KEY(address)) ?? "[]"));
    } catch {
      setPending([]);
    }
  }, [address]);

  useEffect(() => load(), [load]);

  const save = useCallback(
    (list: PendingTransfer[]) => {
      if (address) localStorage.setItem(KEY(address), JSON.stringify(list));
      setPending(list);
    },
    [address],
  );

  /** Burn on Arc. Persist immediately — before anything else can fail. */
  async function bridge() {
    if (!address) return;
    const amt = parse(amount); // 6-dec, matching the USDC ERC-20 interface
    if (amt === 0n) return;
    setBusy(true);
    try {
      setStatus("Approving USDC…");
      await writeContractAsync({
        address: ADDR.usdc as `0x${string}`,
        abi: erc20Abi,
        functionName: "approve",
        args: [CCTP.tokenMessenger as `0x${string}`, amt],
        chainId: arcTestnet.id,
      });

      setStatus(`Burning on Arc → ${dest.label}…`);
      const burnTx = await writeContractAsync({
        address: CCTP.tokenMessenger as `0x${string}`,
        abi: tokenMessengerAbi,
        functionName: "depositForBurn",
        args: [
          amt,
          dest.domain,
          toBytes32(address), // mint to the same address on the destination
          ADDR.usdc as `0x${string}`,
          toBytes32("0x0000000000000000000000000000000000000000"), // anyone may mint
          STANDARD_MAX_FEE,
          STANDARD_FINALITY_THRESHOLD,
        ],
        chainId: arcTestnet.id,
      });

      const entry: PendingTransfer = {
        burnTx,
        amount,
        destKey: dest.key,
        destDomain: dest.domain,
        destChainId: dest.chainId,
        destLabel: dest.label,
        createdAt: Date.now(),
      };
      save([entry, ...pending]);
      setStatus("Burned — waiting for Circle's attestation (can take a few minutes)");
    } catch (e) {
      setStatus((e instanceof Error ? e.message : "failed").split("\n")[0].slice(0, 110));
    } finally {
      setBusy(false);
    }
  }

  /** Poll Circle for the attestation on any burn that doesn't have one yet. */
  useEffect(() => {
    const unattested = pending.filter((p) => !p.attestation && !p.claimTx);
    if (unattested.length === 0) return;
    let alive = true;

    const poll = async () => {
      for (const p of unattested) {
        try {
          const r = await fetch(`/api/cctp?domain=${ARC_DOMAIN}&tx=${p.burnTx}`);
          const j = await r.json();
          if (!alive || j.status !== "complete") continue;
          setPending((cur) => {
            const next = cur.map((x) =>
              x.burnTx === p.burnTx ? { ...x, message: j.message, attestation: j.attestation } : x,
            );
            if (address) localStorage.setItem(KEY(address), JSON.stringify(next));
            return next;
          });
        } catch {
          /* keep waiting */
        }
      }
    };
    void poll();
    const id = setInterval(poll, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pending, address]);

  /** Mint on the destination chain. Switches the wallet first. */
  async function claim(p: PendingTransfer) {
    if (!p.message || !p.attestation) return;
    setBusy(true);
    try {
      if (chainId !== p.destChainId) {
        setStatus(`Switch to ${p.destLabel} in your wallet…`);
        await switchChainAsync({ chainId: p.destChainId as 84532 | 11155111 | 421614 });
      }
      setStatus(`Minting on ${p.destLabel}…`);
      const claimTx = await writeContractAsync({
        address: CCTP.messageTransmitter as `0x${string}`,
        abi: messageTransmitterAbi,
        functionName: "receiveMessage",
        args: [p.message as `0x${string}`, p.attestation as `0x${string}`],
        chainId: p.destChainId as 84532 | 11155111 | 421614,
      });
      save(pending.map((x) => (x.burnTx === p.burnTx ? { ...x, claimTx } : x)));
      setStatus(`Minted on ${p.destLabel} — done`);
    } catch (e) {
      setStatus((e instanceof Error ? e.message : "failed").split("\n")[0].slice(0, 110));
    } finally {
      setBusy(false);
    }
  }

  const clearDone = () => save(pending.filter((p) => !p.claimTx));

  return (
    <div>
      <h2 className="text-sm font-medium text-fg">Bridge USDC</h2>
      <p className="mt-1 text-xs leading-relaxed text-faint">
        Native USDC out of Arc via Circle&apos;s <span className="text-fg">CCTP</span> — your USDC is
        burned here and real USDC is minted on the destination. No wrapped tokens, no liquidity
        pool, no custodian.
      </p>

      <div className="mt-4 grid grid-cols-3 gap-1 rounded-xl border border-[color:var(--line)] bg-black/[0.04] p-1 dark:bg-white/[0.025]">
        {DESTINATIONS.map((d) => (
          <button
            key={d.key}
            onClick={() => setDest(d)}
            className={`rounded-[9px] py-1.5 text-[11px] font-medium transition-all duration-300 ${
              dest.key === d.key ? "bg-indigo/20 text-fg" : "text-faint hover:text-muted"
            }`}
          >
            {d.label.replace(" Sepolia", "")}
          </button>
        ))}
      </div>

      <div className="inner mt-3 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-[0.14em] text-faint">Amount (USDC)</span>
          <span className="font-mono text-[10px] text-faint">domain {dest.domain}</span>
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          className="mt-1 w-full bg-transparent font-mono text-lg tabular text-fg outline-none"
        />
      </div>

      <div className="mt-3 flex items-center justify-center gap-2 font-mono text-[11px] text-muted">
        <span>Arc Testnet</span>
        <ArrowRight size={12} className="text-faint" />
        <span>{dest.label}</span>
      </div>

      <button
        onClick={bridge}
        disabled={!address || busy}
        className="cta mt-4 w-full bg-indigo/80 py-2.5 text-sm font-medium text-white disabled:opacity-25"
      >
        {!address ? "Connect wallet" : busy ? "Working…" : `Bridge to ${dest.label.replace(" Sepolia", "")}`}
      </button>

      {status && (
        <p className="mt-3 break-words text-center font-mono text-[11px] text-muted">{status}</p>
      )}

      {pending.length > 0 && (
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-fg">Pending transfers</h3>
            {pending.some((p) => p.claimTx) && (
              <button onClick={clearDone} className="text-[11px] text-faint hover:text-fg">
                clear completed
              </button>
            )}
          </div>
          <div className="mt-2 space-y-2">
            {pending.map((p) => (
              <div key={p.burnTx} className="inner p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-fg">
                    {p.amount} USDC → {p.destLabel}
                  </span>
                  <a
                    href={`https://testnet.arcscan.app/tx/${p.burnTx}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 font-mono text-[10px] text-faint hover:text-fg"
                  >
                    burn <ExternalLink size={10} />
                  </a>
                </div>
                <div className="mt-2">
                  {p.claimTx ? (
                    <span className="font-mono text-[11px] text-mint">minted ✓</span>
                  ) : p.attestation ? (
                    <button
                      onClick={() => claim(p)}
                      disabled={busy}
                      className="cta w-full bg-mint/80 py-2 text-xs font-medium text-black disabled:opacity-40"
                    >
                      Claim on {p.destLabel.replace(" Sepolia", "")}
                    </button>
                  ) : (
                    <span className="flex items-center gap-1.5 font-mono text-[11px] text-faint">
                      <Loader2 size={11} className="animate-spin" />
                      waiting for Circle attestation…
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-2 text-center text-[10px] leading-relaxed text-faint">
            Transfers are saved in this browser. An unclaimed burn is never lost — attestations
            don&apos;t expire, so you can come back and claim it any time.
          </p>
        </div>
      )}
    </div>
  );
}
