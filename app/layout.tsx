import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Newsreader, Space_Grotesk } from "next/font/google";

import { TRPCProvider } from "@/components/providers/trpc-provider";
import { WalletProvider } from "@/components/providers/wallet-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin", "latin-ext"],
  variable: "--font-space-grotesk",
});

const newsreader = Newsreader({
  subsets: ["latin", "latin-ext"],
  style: ["italic"],
  weight: ["400"],
  variable: "--font-newsreader",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "700"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Pairy · Trade in person.",
  description:
    "Meet a peer nearby and swap cash for XLM or USDC face to face. Stellar testnet demo: Pairy holds no key and never touches the funds.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#F5F1EA",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${newsreader.variable} ${jetbrainsMono.variable}`}>
      <body>
        <TRPCProvider>
          <WalletProvider>{children}</WalletProvider>
        </TRPCProvider>
        <Toaster />
      </body>
    </html>
  );
}
