/**
 * Multi-step input state.
 *
 * Telegram has no forms, so anything needing more than one value walks the user
 * through it. State is in-memory and per-user: it is throwaway UI context, never
 * anything sensitive, and losing it on restart simply means the user starts the
 * flow again.
 */

export type Flow =
  | { kind: "limit"; side: "bid" | "ask"; step: "price" | "amount"; price?: number }
  | { kind: "twap"; step: "total" | "slices" | "interval"; total?: number; slices?: number }
  | { kind: "alert"; step: "price"; direction: "above" | "below" };

const flows = new Map<number, Flow>();

export const setFlow = (id: number, f: Flow) => flows.set(id, f);
export const getFlow = (id: number) => flows.get(id);
export const clearFlow = (id: number) => flows.delete(id);
