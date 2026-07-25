"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useState } from "react";
import { Bot, X } from "lucide-react";
import { BotPanel } from "./BotPanel";

/**
 * Floating bot dock: a launcher pinned bottom-left that opens the trading bot
 * in a popup panel. Kept out of the main terminal tabs so the bot can run and
 * be monitored while the user works in Swap/Make/TWAP.
 */
export function BotDock() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -18, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            style={{ transformOrigin: "top left" }}
            className="glass fixed left-4 top-[52px] z-50 max-h-[74vh] w-[calc(100vw-2rem)] overflow-y-auto p-5 shadow-2xl sm:w-[380px]"
          >
            <button
              onClick={() => setOpen(false)}
              aria-label="Close bot"
              className="absolute right-4 top-4 z-10 flex h-7 w-7 items-center justify-center rounded-lg border border-[color:var(--line)] text-faint transition-colors hover:text-fg"
            >
              <X size={14} />
            </button>
            <BotPanel />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        onClick={() => setOpen((v) => !v)}
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.95 }}
        aria-label={open ? "Close trading bot" : "Open trading bot"}
        className="flex shrink-0 items-center gap-1.5 rounded-md bg-indigo/20 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-indigo transition-colors hover:bg-indigo/30"
      >
        <Bot size={10} />
        <span>Bot</span>
      </motion.button>
    </>
  );
}
