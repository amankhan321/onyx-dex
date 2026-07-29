"use client";

import { useEffect, useRef, useState } from "react";
import { Lock } from "lucide-react";

/**
 * Password prompt for a single signing session.
 *
 * Resolves the promise the signer is awaiting, then clears its own state. The
 * password is never lifted out of this component, never stored, and never
 * survives the action it authorised — the signer wipes the derived key in a
 * finally block as soon as the transactions are sent.
 */
export function UnlockModal({
  open,
  summary,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  summary: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => ref.current?.focus(), 60);
    else setPw("");
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center">
      <div className="glass w-full max-w-sm p-5">
        <div className="flex items-center gap-2">
          <Lock size={14} className="text-mint" />
          <h2 className="text-sm font-medium text-fg">Confirm on this device</h2>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-faint">{summary}</p>

        <input
          ref={ref}
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && pw && onSubmit(pw)}
          placeholder="Wallet password"
          autoComplete="off"
          className="mt-4 w-full rounded-lg border border-[color:var(--line)] bg-transparent px-3 py-2.5 font-mono text-sm text-fg outline-none placeholder:text-faint/50"
        />
        <p className="mt-2 text-[10px] text-faint">
          Unlocks your key just long enough to sign, then wipes it. Never sent anywhere.
        </p>

        <div className="mt-4 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-full border border-[color:var(--line)] py-2.5 text-sm text-muted"
          >
            Cancel
          </button>
          <button
            onClick={() => pw && onSubmit(pw)}
            disabled={!pw}
            className="flex-1 rounded-full bg-indigo py-2.5 text-sm font-semibold text-white disabled:opacity-30"
          >
            Sign
          </button>
        </div>
      </div>
    </div>
  );
}
