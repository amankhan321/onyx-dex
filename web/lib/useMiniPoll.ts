"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Polling for Mini App panels.
 *
 * Every panel needs the same four states, and the important one is `error`:
 * a failed read must never render as "you have nothing". That is the same class
 * of bug as the new-device dead end — the UI asserting absence when it actually
 * has no idea.
 *
 * Polling pauses while the tab is hidden (a backgrounded webview shouldn't burn
 * the RPC or the battery) and refetches on focus, so returning to the app shows
 * fresh data rather than whatever was on screen when it was backgrounded.
 */
export type PollState<T> =
  | { status: "loading"; data: null; error: null }
  | { status: "ready"; data: T; error: null }
  | { status: "error"; data: T | null; error: string };

export function useMiniPoll<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
  intervalMs = 10_000,
) {
  const [state, setState] = useState<PollState<T>>({ status: "loading", data: null, error: null });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const inflight = useRef(false);

  const refetch = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const data = await fetcherRef.current();
      setState({ status: "ready", data, error: null });
    } catch (e) {
      // Keep the last good data visible alongside the error — a blip shouldn't
      // wipe the screen.
      setState((prev) => ({
        status: "error",
        data: prev.data,
        error: e instanceof Error ? e.message.split("\n")[0].slice(0, 120) : "Couldn't load",
      }));
    } finally {
      inflight.current = false;
    }
  }, []);

  useEffect(() => {
    void refetch();
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer) return;
      timer = setInterval(() => void refetch(), intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const onVis = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        void refetch();
        start();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", () => void refetch());
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetch, intervalMs, ...deps]);

  return { ...state, refetch };
}

/**
 * Per-wallet log of transaction hashes this Mini App sent.
 *
 * Public data only. Deliberately NOT getLogs: log-range queries over the mobile
 * RPC proxy have been unreliable, and a local list of what we ourselves sent is
 * both accurate and free.
 */
export type TxRecord = { hash: string; kind: string; at: number };

const txKey = (addr: string) => `onyx-txlog-${addr.toLowerCase()}`;

export function loadTxLog(address: string): TxRecord[] {
  try {
    return JSON.parse(localStorage.getItem(txKey(address)) ?? "[]") as TxRecord[];
  } catch {
    return [];
  }
}

export function appendTxLog(address: string, rec: TxRecord) {
  try {
    const next = [rec, ...loadTxLog(address)].slice(0, 50);
    localStorage.setItem(txKey(address), JSON.stringify(next));
  } catch {
    /* the log is a convenience; losing it must never break a send */
  }
}
