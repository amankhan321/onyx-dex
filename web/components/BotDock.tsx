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
            initial={{ opacity: 0, y: 24, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 260, damping: 26 }}
            style={{ transformOrigin: "bottom left" }}
            className="glass fixed bottom-24 left-5 z-50 max-h-[75vh] w-[calc(100vw-2.5rem)] overflow-y-auto p-5 shadow-2xl sm:w-[380px]"
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
        className="cta fixed bottom-6 left-5 z-50 flex items-center gap-2 rounded-full bg-indigo/90 px-4 py-3 text-sm font-medium text-white shadow-xl"
      >
        <Bot size={16} />
        <span className="hidden sm:inline">Trading bot</span>
      </motion.button>
    </>
  );
}
