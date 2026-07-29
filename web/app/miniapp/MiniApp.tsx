"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownUp, Check, Copy, Download, ListOrdered, Wallet } from "lucide-react";
import { SignerProvider, useKeystoreSigner, type WalletLease } from "@/lib/signer";
import { loadKeystore, storageMode, telegramSession, expand, stableHeight, backButton, haptic } from "@/lib/telegram";
import type { EncryptedKeystore } from "@/lib/keystore";
import { unlock as unlockKeystore, type UnlockedWallet } from "@/lib/keystore";
import { UnlockModal } from "./Unlock";
import { SwapTab } from "./SwapTab";

const FALLBACK_MAX_VALUE = Number(process.env.NEXT_PUBLIC_FALLBACK_MAX_VALUE ?? "100");
/** Idle window for a session unlock. */
const SESSION_MS = 5 * 60 * 1000;
/** Above this (whole tokens), re-prompt even inside a session. */
export const REAUTH_THRESHOLD = Number(process.env.NEXT_PUBLIC_REAUTH_THRESHOLD ?? "50");

type Tab = "swap" | "orders" | "portfolio" | "deposit";

const TABS: { id: Tab; label: string; Icon: typeof ArrowDownUp }[] = [
  { id: "swap", label: "Swap", Icon: ArrowDownUp },
  { id: "orders", label: "Orders", Icon: ListOrdered },
  { id: "portfolio", label: "Portfolio", Icon: Wallet },
  { id: "deposit", label: "Deposit", Icon: Download },
];

/**
 * Mini App shell.
 *
 * Owns the keystore, the password prompt, and the tab layout. The signer is
 * constructed here and handed down through context, so tab components never
 * touch key material — they just call signer.write().
 */
export function MiniApp({ keystore, address }: { keystore: EncryptedKeystore; address: `0x${string}` }) {
  const [tab, setTab] = useState<Tab>("swap");
  const [height, setHeight] = useState<number>(0);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /**
   * Copy the FULL address, not the truncated form shown on screen — a truncated
   * address pasted into a send field would lose funds. Falls back to a hidden
   * textarea because Telegram's webview doesn't always expose the clipboard API.
   */
  const copyAddress = useCallback(async () => {
    haptic.tap();
    try {
      await navigator.clipboard.writeText(address);
    } catch {
      const el = document.createElement("textarea");
      el.value = address;
      el.setAttribute("readonly", "");
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      try {
        document.execCommand("copy");
      } catch {
        /* clipboard unavailable; the address is still visible to read */
      }
      document.body.removeChild(el);
    }
    setCopied(true);
    haptic.success();
    setTimeout(() => setCopied(false), 1600);
  }, [address]);

  // The pending password request: the signer awaits this while the modal is up.
  const pending = useRef<{ resolve: (pw: string) => void; reject: (e: Error) => void } | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [askSummary, setAskSummary] = useState("");

  /**
   * SESSION UNLOCK.
   *
   * The decrypted key is held in memory for a short window so a user isn't
   * asked for their password on every trade. That is a real, deliberate
   * reduction in security, bounded three ways:
   *
   *   - 5 minutes idle, timer reset on interaction;
   *   - wiped the instant the app is backgrounded (visibilitychange), because a
   *     phone set down is the realistic attack;
   *   - wiped on close.
   *
   * Withdrawals and anything above REAUTH_THRESHOLD re-prompt regardless — a
   * borrowed unlocked phone should not be able to move funds off-platform.
   *
   * The password itself is never held. Only the derived wallet is, and only for
   * the session window.
   */
  const session = useRef<{ wallet: UnlockedWallet; expiresAt: number } | null>(null);
  const [sessionActive, setSessionActive] = useState(false);

  const endSession = useCallback(() => {
    session.current?.wallet.wipe();
    session.current = null;
    setSessionActive(false);
  }, []);

  const touchSession = useCallback(() => {
    if (session.current) session.current.expiresAt = Date.now() + SESSION_MS;
  }, []);

  // Idle expiry.
  useEffect(() => {
    const id = setInterval(() => {
      if (session.current && Date.now() > session.current.expiresAt) endSession();
    }, 15_000);
    return () => clearInterval(id);
  }, [endSession]);

  // Backgrounding and close wipe immediately.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        endSession();
        if (pending.current) {
          pending.current.reject(new Error("Cancelled"));
          pending.current = null;
          setAskOpen(false);
        }
      }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", endSession);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", endSession);
      endSession();
    };
  }, [endSession]);

  const promptPassword = useCallback(
    (summary: string) =>
      new Promise<string>((resolve, reject) => {
        pending.current = { resolve, reject };
        setAskSummary(summary);
        setAskOpen(true);
      }),
    [],
  );

  /**
   * Give the signer a wallet, applying session policy. `release()` wipes only
   * when the key is NOT session-held, so the signer cannot extend its lifetime.
   */
  const acquireWallet = useCallback(
    async ({ reauth }: { reauth: boolean }): Promise<WalletLease> => {
      if (!reauth && session.current && Date.now() <= session.current.expiresAt) {
        touchSession();
        return { wallet: session.current.wallet, release: () => touchSession() };
      }

      const password = await promptPassword(
        reauth
          ? "This action moves funds off-platform — confirm your password."
          : "Unlock your wallet to sign.",
      );
      const wallet = await unlockKeystore(keystore, password);

      if (reauth) {
        // Never cache a re-auth unlock: the whole point is that it expires
        // immediately, so a second sensitive action prompts again.
        return { wallet, release: () => wallet.wipe() };
      }

      session.current = { wallet, expiresAt: Date.now() + SESSION_MS };
      setSessionActive(true);
      return { wallet, release: () => touchSession() };
    },
    [keystore, promptPassword, touchSession],
  );

  const signer = useKeystoreSigner({ address, ready: true, acquireWallet });

  // Telegram layout: expand, and follow viewportStableHeight so the bottom nav
  // doesn't jump when the keyboard opens.
  useEffect(() => {
    expand();
    const sync = () => setHeight(stableHeight());
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  }, []);

  // BackButton returns to Swap rather than closing the app mid-flow.
  useEffect(() => {
    const bb = backButton();
    if (!bb) return;
    const onBack = () => {
      haptic.tap();
      setTab("swap");
    };
    if (tab === "swap") bb.hide();
    else {
      bb.show();
      bb.onClick(onBack);
    }
    return () => bb.offClick(onBack);
  }, [tab]);

  const submitPassword = async (pw: string) => {
    // Verify before closing so a typo surfaces here, not mid-transaction. The
    // error text stays deliberately vague — it must not reveal whether the blob
    // or the password was wrong.
    try {
      const probe = await unlockKeystore(keystore, pw);
      probe.wipe();
    } catch {
      haptic.error();
      setAskSummary("Wrong password or corrupted keystore. Try again.");
      return;
    }
    setAskOpen(false);
    pending.current?.resolve(pw);
    pending.current = null;
  };

  const cancelPassword = () => {
    setAskOpen(false);
    pending.current?.reject(new Error("Cancelled"));
    pending.current = null;
  };

  const fallbackCap = storageMode() === "fallback" && FALLBACK_MAX_VALUE > 0 ? FALLBACK_MAX_VALUE : null;

  return (
    <SignerProvider signer={signer}>
      <div
        className="flex flex-col"
        style={{ minHeight: height ? `${height}px` : "100vh" }}
      >
        <header className="flex items-center justify-between px-4 pb-2 pt-3">
          <div className="flex items-center gap-2">
            <div className="h-[16px] w-[16px] rounded-[5px] bg-gradient-to-br from-indigo to-mint" />
            <span className="text-sm font-medium text-fg">Onyx</span>
            <span className="rounded-full border border-[color:var(--line)] px-1.5 py-0.5 text-[9px] text-muted">
              Testnet
            </span>
          </div>
          <button
            onClick={copyAddress}
            aria-label={copied ? "Address copied" : "Copy wallet address"}
            className="flex items-center gap-1.5 rounded-full border border-[color:var(--line)] px-2.5 py-1 font-mono text-[10px] text-muted transition-colors active:bg-white/5"
          >
            {address.slice(0, 6)}…{address.slice(-4)}
            {sessionActive && <span className="text-mint" title="Unlocked">•</span>}
            {copied ? (
              <Check size={11} className="text-mint" />
            ) : (
              <Copy size={11} className="text-faint" />
            )}
          </button>
        </header>

        {fallbackCap && (
          <p className="mx-4 mb-2 rounded-lg border border-yellow-500/30 bg-yellow-500/[0.08] p-2.5 text-[10px] leading-relaxed text-yellow-600">
            Less-secure storage: this Telegram version has no SecureStorage, so your
            encrypted key is in browser storage. Signing is capped at {fallbackCap} USDC.
          </p>
        )}

        <main className="flex-1 overflow-y-auto px-4 pb-24">
          {tab === "swap" && (
            <SwapTab onResult={setTxHash} fallbackCap={fallbackCap} />
          )}
          {tab !== "swap" && (
            <div className="glass mt-4 p-5 text-center">
              <p className="text-sm text-fg">{TABS.find((t) => t.id === tab)?.label}</p>
              <p className="mt-1 text-xs text-faint">Coming in the next build.</p>
            </div>
          )}

          {txHash && (
            <a
              href={`https://testnet.arcscan.app/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 block break-all rounded-lg border border-mint/30 bg-mint/[0.06] p-3 font-mono text-[11px] text-mint"
            >
              Sent — view on Arcscan ↗
            </a>
          )}
        </main>

        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-[color:var(--line)] bg-base/95 backdrop-blur-xl">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => {
                haptic.select();
                setTab(id);
              }}
              className={`flex flex-col items-center gap-1 py-3 text-[10px] ${
                tab === id ? "text-indigo" : "text-faint"
              }`}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </nav>
      </div>

      <UnlockModal
        open={askOpen}
        summary={askSummary}
        onSubmit={submitPassword}
        onCancel={cancelPassword}
      />
    </SignerProvider>
  );
}

/** Exported so the page can show a clear message outside Telegram. */
export function useMiniAppBoot() {
  const [keystore, setKeystore] = useState<EncryptedKeystore | null>(null);
  const [checked, setChecked] = useState(false);
  const session = typeof window !== "undefined" ? telegramSession() : { inApp: false, platform: "unknown", version: "0" };

  useEffect(() => {
    void (async () => {
      setKeystore(await loadKeystore());
      setChecked(true);
    })();
  }, []);

  return { keystore, checked, session, setKeystore };
}
