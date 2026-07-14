import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: "ArcBook — the first on-chain order book on Arc",
  description:
    "Hybrid CLOB + rate-adjusted StableSwap for stablecoin FX. Limit orders, price-time priority, and TWAP — viable because Arc has sub-second finality and one-cent gas.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="aurora min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
