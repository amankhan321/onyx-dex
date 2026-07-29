"use client";

import { useCallback, useEffect, useState } from "react";
import { createWalletClient, http, type Hex } from "viem";
import { AlertTriangle, Check, Copy, Loader2, ShieldCheck } from "lucide-react";
import {
  assertPasswordStrength,
  createKeystore,
  importKeystore,
  withUnlocked,
  type EncryptedKeystore,
} from "@/lib/keystore";
import { clearKeystore, loadAddress, resolveKeystoreDetailed, saveAddress, saveKeystore, storageMode, telegramSession, tg } from "@/lib/telegram";
import { MiniApp } from "./MiniApp";
import { strengthLabel } from "@/lib/passwordStrength";
import { tiersAvailable } from "@/lib/telegram";
import { arcTestnet } from "@/lib/contracts";

/**
 * Mini App — the signing surface.
 *
 * Everything that touches a key happens here, in a webview on the user's own
 * device: mnemonic generation, password entry, scrypt derivation, AES-GCM
 * decryption and signing. The password and the plaintext key never leave this
 * context; the server receives, at most, a broadcast transaction hash.
 *
 * The unsigned transaction arrives as a base64url payload in the URL. It is not
 * secret — but it IS what the user consents to, so it's displayed in full
 * before anything is signed.
 */

type Unsigned = {
  to: Hex;
  data: Hex;
  value: string;
  chainId: number;
  summary: string;
  /** Whole-token value moved, used for the less-secure-storage cap. */
  capValue?: number;
};
type Stage = "loading" | "storage-error" | "onboard" | "backup" | "confirm-backup" | "ready" | "signing" | "done";

/**
 * Cap on what may be signed while the blob sits in the weaker fallback store.
 * A downgraded client shouldn't quietly end up guarding large balances. Set
 * NEXT_PUBLIC_FALLBACK_MAX_VALUE to "0" to disable the cap entirely.
 */
const FALLBACK_MAX_VALUE = Number(process.env.NEXT_PUBLIC_FALLBACK_MAX_VALUE ?? "100");
const ACK_KEY = "onyx_fallback_ack_v1";

export default function MiniAppPage() {
  const [stage, setStage] = useState<Stage>("loading");
  const [keystore, setKeystore] = useState<EncryptedKeystore | null>(null);
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [mode, setMode] = useState<"create" | "import">("create");
  const [password, setPassword] = useState("");
  const [importSecret, setImportSecret] = useState("");
  const [unlockPassword, setUnlockPassword] = useState("");
  const [tx, setTx] = useState<Unsigned | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [cloudOptIn, setCloudOptIn] = useState(true);
  const [tierFailures, setTierFailures] = useState<{ tier: string; reason: string }[]>([]);
  const [mode_, setStorage] = useState<"secure" | "fallback">("secure");
  const [ackedFallback, setAcked] = useState(false);

  // Boot: tell Telegram we're ready, parse any pending tx, load the blob.
  useEffect(() => {
    const app = tg();
    app?.ready();
    app?.expand();

    try {
      const raw = new URLSearchParams(window.location.search).get("tx");
      if (raw) {
        const json = atob(raw.replace(/-/g, "+").replace(/_/g, "/"));
        setTx(JSON.parse(json) as Unsigned);
      }
    } catch {
      setError("That transaction link is malformed. Go back to the bot and try again.");
    }

    const sm = storageMode();
    setStorage(sm);
    if (sm === "fallback") {
      try {
        setAcked(localStorage.getItem(ACK_KEY) === "1");
      } catch {
        setAcked(false);
      }
    }

    void boot();
  }, []);

  /**
   * Resolve the wallet across all storage tiers.
   *
   * Onboarding is shown ONLY when every tier definitively reported empty. If any
   * tier errored — offline, rate-limited, an old client — we show a retry
   * instead, because a wallet probably exists behind that failure and sending
   * the user to "import your seed phrase" is how wallets get lost.
   */
  const boot = useCallback(async () => {
    setStage("loading");
    const [res, addr] = await Promise.all([resolveKeystoreDetailed(), loadAddress()]);
    if (addr) setAddress(addr);

    if (res.status === "found") {
      setKeystore(res.keystore);
      setTierFailures([]);
      setStage("ready");
      return;
    }
    if (res.status === "error") {
      setTierFailures(res.failures);
      setStage("storage-error");
      return;
    }
    setTierFailures([]);
    setStage("onboard");
  }, []);

  const fail = (e: unknown) =>
    setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");

  async function onCreate() {
    setError(null);
    setBusy(true);
    try {
      assertPasswordStrength(password);
      const { mnemonic: m, keystore: ks, address: addr } = await createKeystore(password);
      setMnemonic(m);
      setKeystore(ks);
      setAddress(addr);
      await saveKeystore(ks, { cloud: cloudOptIn });
      await saveAddress(addr);
      setStage("backup");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      setPassword("");
    }
  }

  async function onImport() {
    setError(null);
    setBusy(true);
    try {
      assertPasswordStrength(password);
      const { keystore: ks, address: addr } = await importKeystore(importSecret, password);
      setKeystore(ks);
      setAddress(addr);
      await saveKeystore(ks, { cloud: cloudOptIn });
      await saveAddress(addr);
      setStage("ready");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      setPassword("");
      setImportSecret(""); // never leave a seed phrase sitting in component state
    }
  }

  /** Unlock, sign, broadcast, wipe. The key exists for the length of this call. */
  const onSign = useCallback(async () => {
    if (!keystore || !tx) return;
    setError(null);
    setBusy(true);
    setStage("signing");
    try {
      // Cap applies only while on the degraded storage path.
      // Uses the explicit capValue the builder attached — regex-parsing a human
      // summary would silently mis-cap the moment the wording changed.
      if (mode_ === "fallback" && FALLBACK_MAX_VALUE > 0 && tx.capValue != null) {
        if (tx.capValue > FALLBACK_MAX_VALUE) {
          throw new Error(
            `Capped at ${FALLBACK_MAX_VALUE} USDC while using less-secure storage. ` +
              `Update Telegram to lift this.`,
          );
        }
      }
      const hash = await withUnlocked(keystore, unlockPassword, async (w) => {
        const wallet = createWalletClient({
          account: w.account,
          chain: arcTestnet,
          transport: http(),
        });
        return wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value || "0"),
        });
      });
      setTxHash(hash);
      setStage("done");
    } catch (e) {
      fail(e);
      setStage("ready");
    } finally {
      setBusy(false);
      setUnlockPassword(""); // clear immediately; never persisted
    }
  }, [keystore, tx, unlockPassword]);

  const copyMnemonic = () => {
    if (!mnemonic) return;
    void navigator.clipboard.writeText(mnemonic);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 p-5">
      <header className="flex items-center gap-2">
        <div className="h-[18px] w-[18px] rounded-[6px] bg-gradient-to-br from-indigo to-mint" />
        <span className="text-sm font-medium text-fg">Onyx</span>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-faint">
          <ShieldCheck size={11} className="text-mint" />
          keys stay on this device
        </span>
      </header>

      {mode_ === "fallback" && (
        <Note tone="warn">
          <strong>Less-secure storage in use.</strong> Your encrypted key is being kept in
          this browser&apos;s local storage instead of Telegram&apos;s SecureStorage,
          because this Telegram version doesn&apos;t provide it. That means any script
          running on this page&apos;s domain could read the encrypted file, and clearing
          your browsing data will delete it — losing the wallet unless you still have your
          recovery phrase. It stays encrypted with your password either way.{" "}
          <strong>Update Telegram to move to secure device storage.</strong>
          {FALLBACK_MAX_VALUE > 0 && (
            <> Signing is capped at {FALLBACK_MAX_VALUE} USDC per transaction until you do.</>
          )}
        </Note>
      )}

      {error && <Note tone="error">{error}</Note>}

      {!telegramSession().inApp && stage !== "loading" && (
        <Note tone="warn">
          <strong>Opened outside Telegram.</strong> Telegram&apos;s secure and cloud storage
          aren&apos;t available here, so a wallet created now lives only in this browser
          and will not sync to your account. Open Onyx from the bot to set up properly.
        </Note>
      )}

      {stage === "storage-error" && (
        <section className="glass p-5">
          <h1 className="text-base font-medium text-fg">Couldn&apos;t reach your wallet</h1>
          <p className="mt-2 text-xs leading-relaxed text-faint">
            One or more storage locations didn&apos;t respond, so we can&apos;t tell whether
            you have a wallet here. We won&apos;t ask you to set up a new one until we
            know for sure — that could overwrite an existing wallet.
          </p>
          <ul className="mt-3 space-y-1">
            {tierFailures.map((f) => (
              <li key={f.tier} className="font-mono text-[10px] text-rose">
                {f.tier}: {f.reason}
              </li>
            ))}
          </ul>
          <button
            onClick={() => void boot()}
            className="cta mt-4 w-full bg-indigo py-2.5 text-sm font-semibold text-white"
          >
            Try again
          </button>
          <p className="mt-2 text-center text-[10px] text-faint">
            If this persists, check your connection or update Telegram.
          </p>
        </section>
      )}

      {stage === "loading" && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      )}

      {stage === "onboard" && mode_ === "fallback" && !ackedFallback && (
        <section className="glass p-5">
          <h1 className="text-base font-medium text-fg">Continue with weaker storage?</h1>
          <p className="mt-2 text-xs leading-relaxed text-faint">
            Telegram&apos;s secure storage isn&apos;t available here, so your encrypted key
            would be saved in ordinary browser storage on this device. It stays encrypted
            with your password, but it is easier for other code on this domain to read and
            it disappears if you clear browsing data.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-faint">
            The safer option is to update Telegram and reopen this from the bot.
          </p>
          <button
            onClick={() => {
              try {
                localStorage.setItem(ACK_KEY, "1");
              } catch {
                /* proceeding regardless is the user's choice */
              }
              setAcked(true);
            }}
            className="cta mt-4 w-full bg-indigo py-2.5 text-sm font-semibold text-white"
          >
            I understand, continue anyway
          </button>
        </section>
      )}

      {stage === "onboard" && (mode_ === "secure" || ackedFallback) && (
        <section className="glass p-5">
          <h1 className="text-base font-medium text-fg">Set up your wallet</h1>
          <p className="mt-1 text-xs leading-relaxed text-faint">
            This wallet is yours alone. The password never leaves your phone, and nobody —
            including us — can recover it or your funds if you lose your recovery phrase.
          </p>

          <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl border border-[color:var(--line)] p-1">
            {(["create", "import"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-[9px] py-1.5 text-xs font-medium capitalize ${
                  mode === m ? "bg-indigo/20 text-fg" : "text-faint"
                }`}
              >
                {m === "create" ? "Create new" : "Import"}
              </button>
            ))}
          </div>

          {mode === "import" && (
            <Field
              label="Recovery phrase or private key"
              value={importSecret}
              onChange={setImportSecret}
              type="password"
              placeholder="12 words, or 0x…"
            />
          )}

          <Field
            label="Password"
            value={password}
            onChange={setPassword}
            type="password"
            placeholder="min 10 chars, letters + numbers"
          />
          {password.length > 0 && (
            <p
              className={`mt-1.5 text-[10px] ${
                strengthLabel(password).score === 0
                  ? "text-rose"
                  : strengthLabel(password).score >= 2
                    ? "text-mint"
                    : "text-yellow-600"
              }`}
            >
              {strengthLabel(password).label}
            </p>
          )}
          <p className="mt-2 text-[10px] leading-relaxed text-faint">
            This password encrypts your key. It is never sent anywhere, so it cannot be
            reset — and because your encrypted wallet can sync to your Telegram account,
            it is the only thing protecting your funds if that account is ever
            compromised. Make it long.
          </p>

          {tiersAvailable().cloud && (
            <label className="mt-4 flex items-start gap-2.5 rounded-xl border border-[color:var(--line)] p-3">
              <input
                type="checkbox"
                checked={cloudOptIn}
                onChange={(e) => setCloudOptIn(e.target.checked)}
                className="mt-0.5"
              />
              <span className="text-[11px] leading-relaxed text-muted">
                <span className="text-fg">Keep a backup in my Telegram account.</span> The
                encrypted file is stored in your Telegram account so you don&apos;t lose the
                wallet when you change phones. It is useless without your password.
              </span>
            </label>
          )}

          <button
            onClick={mode === "create" ? onCreate : onImport}
            disabled={busy || !password}
            className="cta mt-4 w-full bg-indigo py-2.5 text-sm font-semibold text-white disabled:opacity-30"
          >
            {busy ? "Encrypting…" : mode === "create" ? "Create wallet" : "Import wallet"}
          </button>
        </section>
      )}

      {stage === "backup" && mnemonic && (
        <section className="glass p-5">
          <h1 className="text-base font-medium text-fg">Save your recovery phrase</h1>
          <Note tone="warn">
            These 12 words are the only way to restore this wallet. Write them down offline.
            If you lose them, the funds are gone — nobody can recover them for you.
          </Note>
          <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl border border-[color:var(--line)] p-3">
            {mnemonic.split(" ").map((w, i) => (
              <span key={i} className="font-mono text-[11px] text-fg">
                <span className="mr-1 text-faint">{i + 1}.</span>
                {w}
              </span>
            ))}
          </div>
          <button
            onClick={copyMnemonic}
            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-[color:var(--line)] py-2 text-xs text-muted"
          >
            {copied ? <Check size={12} className="text-mint" /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={() => setStage("confirm-backup")}
            className="cta mt-3 w-full bg-indigo py-2.5 text-sm font-semibold text-white"
          >
            I&apos;ve saved it
          </button>
        </section>
      )}

      {stage === "confirm-backup" && (
        <section className="glass p-5">
          <h1 className="text-base font-medium text-fg">Confirm</h1>
          <p className="mt-1 text-xs leading-relaxed text-faint">
            Tap below only if you have written the phrase down somewhere safe and offline.
            It will not be shown again.
          </p>
          <button
            onClick={() => {
              setMnemonic(null); // drop it from memory
              setStage("ready");
            }}
            className="cta mt-4 w-full bg-indigo py-2.5 text-sm font-semibold text-white"
          >
            Confirmed — continue
          </button>
          <button
            onClick={() => setStage("backup")}
            className="mt-2 w-full py-2 text-xs text-muted"
          >
            Show me the phrase again
          </button>
        </section>
      )}

      {stage === "ready" && keystore && address && !tx && (
        <MiniApp keystore={keystore} address={address} />
      )}

      {stage === "ready" && !(keystore && address && !tx) && (
        <section className="glass p-5">
          {address && (
            <p className="font-mono text-[11px] text-faint">
              {address.slice(0, 10)}…{address.slice(-6)}
            </p>
          )}

          {tx ? (
            <>
              <h1 className="mt-1 text-base font-medium text-fg">Confirm transaction</h1>
              <div className="mt-3 rounded-xl border border-[color:var(--line)] p-3">
                <p className="text-sm text-fg">{tx.summary}</p>
                <p className="mt-2 break-all font-mono text-[10px] text-faint">to {tx.to}</p>
              </div>
              <Field
                label="Password"
                value={unlockPassword}
                onChange={setUnlockPassword}
                type="password"
                placeholder="unlock to sign"
              />
              <button
                onClick={onSign}
                disabled={busy || !unlockPassword}
                className="cta mt-4 w-full bg-indigo py-2.5 text-sm font-semibold text-white disabled:opacity-30"
              >
                {busy ? "Signing…" : "Sign & send"}
              </button>
            </>
          ) : (
            <>
              <h1 className="mt-1 text-base font-medium text-fg">Wallet ready</h1>
              <p className="mt-1 text-xs leading-relaxed text-faint">
                Head back to the bot and pick a trade. This screen opens again to confirm
                and sign it.
              </p>
              <button
                onClick={async () => {
                  await clearKeystore();
                  setKeystore(null);
                  setAddress(null);
                  setStage("onboard");
                }}
                className="mt-4 w-full py-2 text-xs text-rose"
              >
                Remove wallet from this device
              </button>
            </>
          )}
        </section>
      )}

      {stage === "signing" && (
        <section className="glass flex items-center gap-2 p-5 text-sm text-muted">
          <Loader2 size={14} className="animate-spin" /> Signing on this device…
        </section>
      )}

      {stage === "done" && txHash && (
        <section className="glass p-5">
          <h1 className="text-base font-medium text-fg">Sent</h1>
          <a
            href={`https://testnet.arcscan.app/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="mt-2 block break-all font-mono text-[11px] text-indigo"
          >
            {txHash}
          </a>
          <button
            onClick={() => tg()?.close()}
            className="cta mt-4 w-full bg-indigo py-2.5 text-sm font-semibold text-white"
          >
            Back to the bot
          </button>
        </section>
      )}
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <label className="mt-3 block">
      <span className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="mt-1 w-full rounded-lg border border-[color:var(--line)] bg-transparent px-3 py-2 font-mono text-sm text-fg outline-none placeholder:text-faint/50"
      />
    </label>
  );
}

function Note({ tone, children }: { tone: "warn" | "error"; children: React.ReactNode }) {
  const c =
    tone === "error"
      ? "border-rose/30 bg-rose/[0.06] text-rose"
      : "border-yellow-500/30 bg-yellow-500/[0.06] text-yellow-600";
  return (
    <div className={`flex gap-2 rounded-xl border p-3 text-[11px] leading-relaxed ${c}`}>
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
