"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

/** Dark (default) <-> light, persisted. Sets data-theme on <html>. */
export function ThemeToggle() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("onyx-theme");
    // Default to LIGHT unless the user explicitly chose dark.
    const isLight = saved !== "dark";
    setLight(isLight);
    document.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");
  }, []);

  const toggle = () => {
    const next = !light;
    setLight(next);
    document.documentElement.setAttribute("data-theme", next ? "light" : "dark");
    localStorage.setItem("onyx-theme", next ? "light" : "dark");
  };

  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      className="btn flex h-8 w-8 items-center justify-center rounded-lg border border-[color:var(--line)] text-muted hover:text-fg"
    >
      {light ? <Moon size={14} /> : <Sun size={14} />}
    </button>
  );
}
