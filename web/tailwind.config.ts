import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "#0A0B0F",
        raise: "#0E1015",
        sink: "#07080B",
        fg: "#EDEEF2",
        muted: "#8A8F98",
        faint: "#6A7080",
        indigo: "#5E6AD2",
        mint: "#2ED3A7",
        rose: "#FF5C6C",
      },
      fontFamily: {
        sans: ["'Fira Sans'", "system-ui", "sans-serif"],
        mono: ["'Fira Code'", "ui-monospace", "monospace"],
      },
      transitionTimingFunction: { ease: "cubic-bezier(0.16,1,0.3,1)" },
    },
  },
  plugins: [],
} satisfies Config;
