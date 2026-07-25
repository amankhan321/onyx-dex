"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import { Bot, X } from "lucide-react";
import { BotPanel } from "./BotPanel";

/**
 * Trading bot launcher + dashboard.
 *
 * The dashboard is a CENTERED MODAL, not an anchored dropdown. Two reasons:
 * it's always in the viewport regardless of scroll position, and it sidesteps
 * the bug that bit the earlier versions — `.glass` and `.cta` both set
 * position: relative in globals.css, and as plain CSS loaded after Tailwind
 * they beat the `fixed` utility, so any element carrying them fell back into
 * document flow and rendered down by the footer. Here the fixed overlay is a
 * plain wrapper and `.glass` only ever styles the inner card, which is the
 * same structure SwapModal uses.
 */
export function BotDock() {
  const [open, setOpen] = useState(false);

  // Escape closes; body scroll locks while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/65 p-4 backdrop-blur-sm sm:items-center"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 16 }}
              transition={{ type: "spring", stiffness: 280, damping: 26 }}
              onClick={(e) => e.stopPropagation()}
              className="glass relative my-auto w-full max-w-md p-6"
            >
              <button
                onClick={() => setOpen(false)}
                aria-label="Close trading bot"
                className="absolute right-4 top-4 z-10 flex h-7 w-7 items-center justify-center rounded-lg border border-[color:var(--line)] text-faint transition-colors hover:text-fg"
              >
                <X size={14} />
              </button>
              <BotPanel />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        onClick={() => setOpen(true)}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.96 }}
        aria-label="Open trading bot"
        className="fixed bottom-6 left-5 z-40 flex items-center gap-2 rounded-full bg-indigo px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_30px_rgba(94,106,210,0.45)] ring-1 ring-white/15 lg:bottom-auto lg:left-8 lg:top-[124px]"
      >
        <Bot size={16} />
        <span>Trading bot</span>
      </motion.button>
    </>
  );
}
