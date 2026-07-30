"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { AlertTriangle, Check, Copy, ExternalLink } from "lucide-react";
import { arcTestnet } from "@/lib/contracts";
import { useSigner } from "@/lib/signer";
import { haptic } from "@/lib/telegram";

/**
 * Deposit.
 *
 * The QR is generated on-device rather than through an image service — sending
 * a user's address to a third party to be rendered would leak it for no reason.
 */
export function DepositTab() {
  const signer = useSigner();
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!signer.address) return;
    let alive = true;
    void QRCode.toDataURL(signer.address, {
      width: 480,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => {
        if (alive) setQr(url);
      })
      .catch(() => {
        // A missing QR is cosmetic — the address text is the source of truth.
        if (alive) setQr(null);
      });
    return () => {
      alive = false;
    };
  }, [signer.address]);

  const copy = async () => {
    if (!signer.address) return;
    haptic.tap();
    try {
      await navigator.clipboard.writeText(signer.address);
    } catch {
      const el = document.createElement("textarea");
      el.value = signer.address;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } catch {
        /* clipboard unavailable; address remains readable on screen */
      }
      document.body.removeChild(el);
    }
    setCopied(true);
    haptic.success();
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="space-y-3">
      {/* Network warning first: sending on the wrong chain is the one mistake
          here that cannot be undone, so it appears before the address. */}
      <div className="rounded-xl border border-yellow-500/40 bg-yellow-500/[0.08] p-3">
        <div className="flex gap-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-yellow-600" />
          <p className="text-[11px] leading-relaxed text-yellow-600">
            <strong>Arc Testnet only</strong> (chain id {arcTestnet.id}). Funds sent on any
            other network go to an address nobody controls and are permanently lost.
          </p>
        </div>
      </div>

      <section className="inner p-4 text-center">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={qr}
            alt="Your Arc testnet deposit address as a QR code"
            className="mx-auto h-44 w-44 rounded-lg bg-white p-2"
          />
        ) : (
          <div className="mx-auto h-44 w-44 animate-pulse rounded-lg bg-white/10" />
        )}

        <p className="mt-3 break-all font-mono text-[11px] leading-relaxed text-fg">
          {signer.address}
        </p>

        <button
          onClick={copy}
          className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-full bg-indigo text-sm font-semibold text-white"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy address"}
        </button>
      </section>

      <a
        href="https://faucet.circle.com/"
        target="_blank"
        rel="noreferrer"
        className="inner flex min-h-[44px] items-center justify-between p-4"
      >
        <span>
          <span className="block text-sm text-fg">Get testnet USDC</span>
          <span className="mt-0.5 block text-[11px] text-faint">
            Circle&apos;s faucet — choose Arc Testnet
          </span>
        </span>
        <ExternalLink size={14} className="shrink-0 text-faint" />
      </a>

      {/*
        CCTP deliberately absent here rather than half-built.
        A CCTP deposit burns USDC on the SOURCE chain, which means signing on
        Ethereum/Base/Arbitrum. This wallet is Arc-only in the Mini App, so the
        burn cannot be signed from here — a button would either do nothing or,
        worse, look like it worked. The desktop bridge already does it properly.
      */}
      <div className="inner p-4">
        <span className="block text-sm text-fg">Bringing USDC from another chain?</span>
        <p className="mt-1 text-[11px] leading-relaxed text-faint">
          Circle&apos;s CCTP burns USDC on the source chain, so that step has to be signed
          there — not from this Arc wallet. Use the bridge on the desktop app at{" "}
          <span className="text-fg">onyx-dex.vercel.app</span>, then the USDC arrives at the
          address above.
        </p>
      </div>
    </div>
  );
}
