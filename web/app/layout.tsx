import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Ambient } from "@/components/Ambient";
import { Starfield } from "@/components/Starfield";
import { Footer } from "@/components/Footer";
import { Ticker } from "@/components/Ticker";

export const metadata: Metadata = {
  title: "Onyx — an on-chain order book, built on Arc",
  description:
    "Hybrid CLOB + rate-adjusted StableSwap for stablecoin FX. Limit orders, price-time priority and TWAP — viable because Arc has sub-second finality and one-cent gas.",
  openGraph: {
    title: "Onyx — an on-chain order book, built on Arc",
    description: "Onyx — an on-chain order book. Hybrid CLOB + rate-adjusted StableSwap for USDC/EURC, built on Arc.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light">
      <head>
        {/* Loaded via <link> rather than next/font so the build never needs
            network access to Google — it fetches in the browser instead. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=Fira+Sans:wght@300;400;500;600&family=Instrument+Serif:ital@0;1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <Ambient />
        <Starfield />
        <Providers>
          <div className="relative z-10 flex min-h-screen flex-col">
            <Ticker />
            <div className="flex-1">{children}</div>
            <Footer />
          </div>
        </Providers>
      </body>
    </html>
  );
}
