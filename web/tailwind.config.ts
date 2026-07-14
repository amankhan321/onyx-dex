import type { Config } from "tailwindcss";
export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#08090B",
        panel: "#0E1013",
        line: "#1C1F26",
        muted: "#6B7280",
        soft: "#9BA3AF",
        bid: "#2ED3A7",
        ask: "#FF5C6C",
        accent: "#7C8CFF",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
