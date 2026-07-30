"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Cloud, CloudOff, Info, KeyRound, Loader2, Trash2 } from "lucide-react";
import {
  KeystoreCorruptError,
  WrongPasswordError,
  changePassword as reencrypt,
  type EncryptedKeystore,
} from "@/lib/keystore";
import { checkPasswordStrength } from "@/lib/passwordStrength";
import {
  backupToCloud,
  clearKeystore,
  clearKeystoreLocal,
  isInCloud,
  removeFromCloud,
  saveKeystore,
  telegramDiagnostics,
  tiersAvailable,
  waitForTelegram,
} from "@/lib/telegram";
import { haptic } from "@/lib/telegram";

/**
 * Wallet settings — cloud backup and password change.
 *
 * Both actions here handle the encrypted blob only. The password is used
 * in-memory to re-encrypt and is never stored; the plaintext key exists just
 * long enough to be re-wrapped and is wiped by withUnlocked/importKeystore.
 */
export function SettingsTab({
  keystore,
  onKeystoreChange,
}: {
  keystore: EncryptedKeystore;
  onKeystoreChange: (ks: EncryptedKeystore) => void;
}) {
  const [inCloud, setInCloud] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [changing, setChanging] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");

  // Same validator as the crypto layer, surfaced per keystroke.
  const newCheck = newPw.length > 0 ? checkPasswordStrength(newPw) : null;
  const newOk = newCheck?.ok === true;
  const running = useRef(false);

  const cloudAvailable = tiersAvailable().cloud;
  const [diag, setDiag] = useState(telegramDiagnostics());
  const [removing, setRemoving] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [wipeEverywhere, setWipeEverywhere] = useState(false);

  // Re-read once the SDK has attached so diagnostics reflect reality, not the
  // state of the world before the script loaded.
  useEffect(() => {
    void (async () => {
      await waitForTelegram();
      setDiag(telegramDiagnostics());
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!cloudAvailable) return setInCloud(false);
    setInCloud(await isInCloud());
  }, [cloudAvailable]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function toggleCloud() {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (inCloud) {
        const ok = await removeFromCloud();
        if (!ok) throw new Error("Couldn't reach Telegram cloud storage.");
        setInCloud(false);
        setMsg("Removed from your Telegram account. This device still has the wallet.");
      } else {
        const ok = await backupToCloud(keystore);
        if (!ok) throw new Error("Couldn't reach Telegram cloud storage.");
        setInCloud(true);
        setMsg("Backed up. You can restore on a new phone with your password.");
      }
      haptic.success();
    } catch (e) {
      haptic.error();
      setErr(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Change password: decrypt with the old one, re-encrypt with the new, then
   * write to every tier the wallet already lives in. If the cloud copy isn't
   * updated the user would be left with a backup that only opens with a
   * password they've stopped using — worse than no backup, because they'd
   * believe they were covered.
   */
  async function changePassword() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (newPw !== confirmPw) throw new Error("The new passwords don't match.");
      const strength = checkPasswordStrength(newPw);
      if (!strength.ok) throw new Error(strength.reason);

      // The key is decrypted, re-wrapped and wiped inside the keystore module —
      // it never reaches this component.
      const rewrapped = await reencrypt(keystore, oldPw, newPw);

      await saveKeystore(rewrapped, { cloud: Boolean(inCloud) });
      onKeystoreChange(rewrapped);
      setChanging(false);
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
      haptic.success();
      setMsg(inCloud ? "Password changed, cloud backup updated." : "Password changed.");
    } catch (e) {
      haptic.error();
      if (e instanceof WrongPasswordError) setErr("Current password is wrong.");
      else if (e instanceof KeystoreCorruptError) setErr(e.message);
      else setErr(e instanceof Error ? e.message : "Couldn't change the password.");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <section className="inner p-4">
        <div className="flex items-start gap-2">
          {inCloud ? (
            <Cloud size={15} className="mt-0.5 text-mint" />
          ) : (
            <CloudOff size={15} className="mt-0.5 text-faint" />
          )}
          <div className="flex-1">
            <h3 className="text-sm font-medium text-fg">Telegram cloud backup</h3>
            <p className="mt-1 text-[11px] leading-relaxed text-faint">
              Your encrypted wallet file is stored in your Telegram account so you don&apos;t
              lose it when you change phones. It is useless without your password.
            </p>
            {inCloud === null ? (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-faint">
                <Loader2 size={11} className="animate-spin" /> checking…
              </p>
            ) : !cloudAvailable ? (
              <p className="mt-2 text-[11px] text-yellow-600">
                Your Telegram version doesn&apos;t support cloud storage — update to enable
                this.
              </p>
            ) : (
              <button
                onClick={toggleCloud}
                disabled={busy}
                className={`mt-3 w-full rounded-full py-2 text-xs font-medium disabled:opacity-40 ${
                  inCloud
                    ? "border border-[color:var(--line)] text-muted"
                    : "bg-indigo text-white"
                }`}
              >
                {inCloud ? "Remove from Telegram cloud" : "Back up to Telegram"}
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="inner p-4">
        <div className="flex items-start gap-2">
          <KeyRound size={15} className="mt-0.5 text-faint" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-fg">Change password</h3>
            {!changing ? (
              <>
                <p className="mt-1 text-[11px] leading-relaxed text-faint">
                  Re-encrypts your wallet everywhere it&apos;s stored, including the cloud
                  backup.
                </p>
                <button
                  onClick={() => setChanging(true)}
                  className="mt-3 w-full rounded-full border border-[color:var(--line)] py-2 text-xs text-muted"
                >
                  Change password
                </button>
              </>
            ) : (
              <div className="mt-2 space-y-2">
                <input
                  type="password"
                  value={oldPw}
                  onChange={(e) => setOldPw(e.target.value)}
                  placeholder="Current password"
                  autoComplete="off"
                  className="w-full rounded-lg border border-[color:var(--line)] bg-transparent px-3 py-2 font-mono text-xs text-fg outline-none"
                />
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  placeholder="New password"
                  autoComplete="off"
                  className="w-full rounded-lg border border-[color:var(--line)] bg-transparent px-3 py-2 font-mono text-xs text-fg outline-none"
                />
                {newCheck && (
                  <p className={`text-[10px] leading-relaxed ${newOk ? "text-mint" : "text-rose"}`}>
                    {newOk ? "Looks good." : newCheck.reason}
                  </p>
                )}
                <input
                  type="password"
                  value={confirmPw}
                  onChange={(e) => setConfirmPw(e.target.value)}
                  placeholder="Confirm new password"
                  autoComplete="off"
                  className="w-full rounded-lg border border-[color:var(--line)] bg-transparent px-3 py-2 font-mono text-xs text-fg outline-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setChanging(false);
                      setOldPw("");
                      setNewPw("");
                      setConfirmPw("");
                      setErr(null);
                    }}
                    className="flex-1 rounded-full border border-[color:var(--line)] py-2 text-xs text-muted"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={changePassword}
                    disabled={busy || !oldPw || !newOk || newPw !== confirmPw}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded-full bg-indigo py-2 text-xs font-semibold text-white disabled:opacity-30"
                  >
                    {busy && <Loader2 size={12} className="animate-spin" />}
                    {busy ? "Re-encrypting…" : "Save"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="inner p-4">
        <div className="flex items-start gap-2">
          <Trash2 size={15} className="mt-0.5 text-rose" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-fg">Remove wallet</h3>
            {!removing ? (
              <>
                <p className="mt-1 text-[11px] leading-relaxed text-faint">
                  Removes the wallet from this device. Your Telegram cloud backup is kept
                  unless you choose otherwise.
                </p>
                <button
                  onClick={() => setRemoving(true)}
                  className="mt-3 w-full rounded-full border border-rose/40 py-2 text-xs text-rose"
                >
                  Remove wallet…
                </button>
              </>
            ) : (
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-2 text-[11px] leading-relaxed text-muted">
                  <input
                    type="checkbox"
                    checked={wipeEverywhere}
                    onChange={(e) => setWipeEverywhere(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Also delete the Telegram cloud backup.{" "}
                    <span className="text-rose">
                      This removes it from every device permanently — only your recovery
                      phrase could restore it.
                    </span>
                  </span>
                </label>
                <p className="text-[11px] text-faint">
                  Type <span className="font-mono text-fg">REMOVE</span> to confirm.
                </p>
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="REMOVE"
                  autoComplete="off"
                  className="w-full rounded-lg border border-[color:var(--line)] bg-transparent px-3 py-2 font-mono text-xs text-fg outline-none"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setRemoving(false);
                      setConfirmText("");
                      setWipeEverywhere(false);
                    }}
                    className="flex-1 rounded-full border border-[color:var(--line)] py-2 text-xs text-muted"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      if (confirmText !== "REMOVE") return;
                      if (wipeEverywhere) await clearKeystore();
                      else await clearKeystoreLocal();
                      location.reload();
                    }}
                    disabled={confirmText !== "REMOVE"}
                    className="flex-1 rounded-full bg-rose py-2 text-xs font-semibold text-white disabled:opacity-30"
                  >
                    Remove
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="inner p-4">
        <div className="flex items-start gap-2">
          <Info size={15} className="mt-0.5 text-faint" />
          <div className="flex-1">
            <h3 className="text-sm font-medium text-fg">Diagnostics</h3>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 font-mono text-[10px] text-faint">
              <dt>Telegram</dt>
              <dd className="text-fg">{diag.present ? `v${diag.version}` : "not detected"}</dd>
              <dt>Platform</dt>
              <dd className="text-fg">{diag.platform}</dd>
              <dt>SecureStorage</dt>
              <dd className={diag.secure ? "text-mint" : "text-yellow-600"}>
                {diag.secure ? "available" : "unavailable"}
              </dd>
              <dt>CloudStorage</dt>
              <dd className={diag.cloud ? "text-mint" : "text-yellow-600"}>
                {diag.cloud ? "available" : "unavailable"}
              </dd>
              <dt>Local storage</dt>
              <dd className={diag.local ? "text-mint" : "text-rose"}>
                {diag.local ? "available" : "unavailable"}
              </dd>
            </dl>
          </div>
        </div>
      </section>

      {msg && (
        <p className="flex items-start gap-1.5 rounded-lg border border-mint/30 bg-mint/[0.06] p-3 text-[11px] text-mint">
          <Check size={12} className="mt-0.5 shrink-0" />
          {msg}
        </p>
      )}
      {err && (
        <p className="rounded-lg border border-rose/30 bg-rose/[0.06] p-3 text-[11px] text-rose">{err}</p>
      )}
    </div>
  );
}
