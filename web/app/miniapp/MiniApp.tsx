"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownUp, Check, Copy, Download, ListOrdered, Settings2, Wallet } from "lucide-react";
import { SignerProvider, useKeystoreSigner, type WalletLease } from "@/lib/signer";
import { loadKeystore, storageMode, telegramSession, expand, stableHeight, backButton, haptic } from "@/lib/telegram";
import type { EncryptedKeystore } from "@/lib/keystore";
import { unlock as unlockKeystore, type UnlockedWallet } from "@/lib/keystore";
import { UnlockModal } from "./Unlock";
import { SwapTab } from "./SwapTab";
import { IntentConfirm } from "./IntentConfirm";
import { SettingsTab } from "./SettingsTab";
import { ActivityTab } from "./ActivityTab";
import { PortfolioTab } from "./PortfolioTab";
import { DepositTab } from "./DepositTab";
import { usePublicClient } from "wagmi";
import { ADDR, arcTestnet, bookAbi } from "@/lib/contracts";
import { isInCloud, tiersAvailable, backupToCloud, initData, waitForTelegram, startParam } from "@/lib/telegram";

const FALLBACK_MAX_VALUE = Number(process.env.NEXT_PUBLIC_FALLBACK_MAX_VALUE ?? "100");
/** Idle window for a session unlock — the hard cap regardless of activity. */
const SESSION_MS = 5 * 60 * 1000;
/**
 * Grace period after the app is backgrounded before the key is wiped.
 *
 * Telegram's webview goes hidden constantly on mobile — an incoming call, the
 * app switcher, pulling down notifications. Wiping instantly meant retyping a
 * password all day, which pushes people toward shorter passwords: a security
 * loss dressed as a security win. 45s is long enough to survive a glance at
 * another app, short enough that a set-down phone is protected.
 */
const HIDDEN_GRACE_MS = 45 * 1000;
/** Above this (whole tokens), re-prompt even inside a session. */
export const REAUTH_THRESHOLD = Number(process.env.NEXT_PUBLIC_REAUTH_THRESHOLD ?? "50");

type Tab = "swap" | "orders" | "portfolio" | "deposit" | "settings";

const TABS: { id: Tab; label: string; Icon: typeof ArrowDownUp }[] = [
  { id: "swap", label: "Swap", Icon: ArrowDownUp },
  { id: "orders", label: "Activity", Icon: ListOrdered },
  { id: "portfolio", label: "Portfolio", Icon: Wallet },
  { id: "deposit", label: "Deposit", Icon: Download },
  { id: "settings", label: "Settings", Icon: Settings2 },
];

/**
 * Mini App shell.
 *
 * Owns the keystore, the password prompt, and the tab layout. The signer is
 * constructed here and handed down through context, so tab components never
 * touch key material — they just call signer.write().
 */
export function MiniApp({
  keystore: initialKeystore,
  address,
}: {
  keystore: EncryptedKeystore;
  address: `0x${string}`;
}) {
  const [keystore, setKeystore] = useState(initialKeystore);
  const [tab, setTab] = useState<Tab>("swap");
  /**
   * A chat-initiated trade arrives as an opaque id in start_param. When present
   * the app opens straight onto the confirm screen — no navigation, no retyping.
   * Captured once on mount so dismissing it cannot be undone by a re-render.
   */
  const [intentPending, setIntentPending] = useState(false);
  useEffect(() => {
    if (startParam()) setIntentPending(true);
  }, []);
  const [height, setHeight] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  const [offerBackup, setOfferBackup] = useState(false);
  const [hasClaimable, setHasClaimable] = useState(false);
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  /**
   * Poll claimable balances so the Orders tab can carry a badge. Unclaimed
   * fills are real funds sitting in the book; without a nudge people simply
   * don't know they're there.
   */
  useEffect(() => {
    if (!publicClient) return;
    let alive = true;
    const check = async () => {
      if (document.visibilityState === "hidden") return;
      try {
        const [b, q] = (await publicClient.multicall({
          allowFailure: false,
          contracts: [
            { address: ADDR.book as `0x${string}`, abi: bookAbi, functionName: "claimableBase", args: [address] },
            { address: ADDR.book as `0x${string}`, abi: bookAbi, functionName: "claimableQuote", args: [address] },
          ],
        })) as [bigint, bigint];
        if (alive) setHasClaimable(b > 0n || q > 0n);
      } catch {
        /* a failed check must not imply "nothing to claim" — leave it as-is */
      }
    };
    void check();
    const id = setInterval(check, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [publicClient, address]);

  /**
   * Storage mode is STATE, not a render-time call.
   *
   * Computing it inline meant a late-attaching SDK produced a permanent
   * "less-secure storage" banner and a 100 USDC cap on a fully capable client,
   * with no re-check once the SDK arrived. We start optimistic (no warning),
   * wait for the SDK, then report what detection actually finds — so the
   * warning and cap appear only when the client genuinely lacks a secure tier.
   */
  const [secureTier, setSecureTier] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      await waitForTelegram();
      if (alive) setSecureTier(tiersAvailable().secure);
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Existing users set up before cloud backup existed have a device-only
   * wallet: change phones and it's gone unless they kept the seed phrase.
   * Offer once, remember the answer, never nag.
   */
  useEffect(() => {
    void (async () => {
      if (!tiersAvailable().cloud) return;
      try {
        if (localStorage.getItem("onyx_backup_prompted_v1")) return;
      } catch {
        return;
      }
      if (!(await isInCloud())) setOfferBackup(true);
    })();
  }, []);

  /**
   * Tell the server which Telegram account this address belongs to, so fill and
   * price alerts reach the right chat. The server verifies the initData HMAC
   * before storing anything — otherwise anyone could claim any telegram_id and
   * redirect someone else's notifications to themselves.
   *
   * Public address only. Fire-and-forget: notifications are a convenience, and
   * failing to register one must never block the wallet from working.
   */
  useEffect(() => {
    const data = initData();
    if (!data) return;
    void fetch("/api/telegram/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, initData: data }),
    }).catch(() => undefined);
  }, [address]);

  const dismissBackupOffer = useCallback(() => {
    try {
      localStorage.setItem("onyx_backup_prompted_v1", "1");
    } catch {
      /* the offer simply reappears next launch */
    }
    setOfferBackup(false);
  }, []);

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
  const [unlocking, setUnlocking] = useState(false);
  // Derivation takes seconds; a ref closes the double-tap window that a
  // disabled-button check alone leaves open.
  const unlockingRef = useRef(false);

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

  // Backgrounding starts a grace timer; closing wipes immediately.
  const hiddenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const cancelGrace = () => {
      if (hiddenTimer.current) {
        clearTimeout(hiddenTimer.current);
        hiddenTimer.current = null;
      }
    };

    const onVis = () => {
      if (document.visibilityState === "hidden") {
        // A prompt awaiting a password is always cancelled at once — leaving a
        // signing request open on a backgrounded app is its own hazard.
        if (pending.current) {
          pending.current.reject(new Error("Cancelled"));
          pending.current = null;
          setAskOpen(false);
        }
        cancelGrace();
        hiddenTimer.current = setTimeout(endSession, HIDDEN_GRACE_MS);
      } else {
        // Back within the grace window: keep the session, but don't extend the
        // 5-minute idle cap, which continues to run underneath.
        cancelGrace();
      }
    };

    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", endSession);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", endSession);
      cancelGrace();
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
    if (unlockingRef.current) return;
    unlockingRef.current = true;
    setUnlocking(true);
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
    } finally {
      unlockingRef.current = false;
      setUnlocking(false);
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

  // null = still detecting; withhold the warning rather than flashing a false one.
  const fallbackCap =
    secureTier === false && FALLBACK_MAX_VALUE > 0 ? FALLBACK_MAX_VALUE : null;

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

        {offerBackup && (
          <div className="mx-4 mb-2 rounded-xl border border-indigo/30 bg-indigo/[0.08] p-3">
            <p className="text-[11px] leading-relaxed text-fg">
              <strong>Back up your wallet?</strong> Your encrypted wallet file can be stored
              in your Telegram account so you don&apos;t lose it when you change phones. It
              is useless without your password.
            </p>
            <div className="mt-2.5 flex gap-2">
              <button
                onClick={dismissBackupOffer}
                className="flex-1 rounded-full border border-[color:var(--line)] py-1.5 text-[11px] text-muted"
              >
                Not now
              </button>
              <button
                onClick={async () => {
                  haptic.tap();
                  await backupToCloud(keystore);
                  dismissBackupOffer();
                  haptic.success();
                }}
                className="flex-1 rounded-full bg-indigo py-1.5 text-[11px] font-semibold text-white"
              >
                Back up
              </button>
            </div>
          </div>
        )}

        {intentPending && (
          <IntentConfirm
            sessionWarm={sessionActive}
            onDone={() => {
              setIntentPending(false);
              setTab("orders");
            }}
            onDismiss={() => setIntentPending(false)}
          />
        )}

        <main className="flex-1 overflow-y-auto px-4 pb-24">
          {tab === "swap" && (
            <SwapTab fallbackCap={fallbackCap} />
          )}
          {tab === "orders" && <ActivityTab />}
          {tab === "portfolio" && <PortfolioTab onGoDeposit={() => setTab("deposit")} />}
          {tab === "deposit" && <DepositTab />}
          {tab === "settings" && (
            <SettingsTab keystore={keystore} onKeystoreChange={setKeystore} />
          )}

        </main>

        <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[color:var(--line)] bg-base/95 backdrop-blur-xl">
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
              <span className="relative">
                <Icon size={17} />
                {id === "orders" && hasClaimable && (
                  <span className="absolute -right-1 -top-0.5 h-1.5 w-1.5 rounded-full bg-mint" />
                )}
              </span>
              {label}
            </button>
          ))}
        </nav>
      </div>

      <UnlockModal
        open={askOpen}
        summary={askSummary}
        busy={unlocking}
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
