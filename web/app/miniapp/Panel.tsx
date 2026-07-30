"use client";

import { AlertCircle, Loader2 } from "lucide-react";

/** Shared skeleton so every panel's loading state looks the same. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="inner p-3" style={{ opacity: 1 - i * 0.22 }}>
          <div className="h-3 w-24 animate-pulse rounded bg-white/10" />
          <div className="mt-2 h-3 w-16 animate-pulse rounded bg-white/[0.07]" />
        </div>
      ))}
    </div>
  );
}

/**
 * Error state with a retry. Deliberately distinct from empty: "we couldn't
 * read this" and "you have none of these" are different facts, and conflating
 * them is how users conclude their funds vanished.
 */
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-rose/30 bg-rose/[0.06] p-4">
      <div className="flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose" />
        <div className="flex-1">
          <p className="text-xs text-rose">Couldn&apos;t load this right now.</p>
          <p className="mt-1 break-words font-mono text-[10px] text-rose/80">{message}</p>
          <button
            onClick={onRetry}
            className="mt-3 min-h-[44px] w-full rounded-full border border-rose/40 text-xs text-rose"
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

/** Empty state always carries one useful next action — never a dead end. */
export function EmptyState({
  title,
  hint,
  actionLabel,
  onAction,
}: {
  title: string;
  hint: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="inner p-5 text-center">
      <p className="text-sm text-fg">{title}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-faint">{hint}</p>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="mt-4 min-h-[44px] w-full rounded-full bg-indigo px-4 text-sm font-semibold text-white"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function Spinner() {
  return <Loader2 size={13} className="animate-spin" />;
}

export const arcscan = (hash: string) => `https://testnet.arcscan.app/tx/${hash}`;
