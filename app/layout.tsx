import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import { ThemeProvider } from "next-themes";

import { TRPCProvider } from "@/components/providers/trpc-provider";
import { WalletProvider } from "@/components/providers/wallet-provider";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
});

export const metadata: Metadata = {
  title: "Pairy — trade in person",
  description:
    "Local, in-person cash ↔ crypto trades on Stellar testnet, settled by a two-claimant claimable balance. Pairy holds no key and no on-chain role.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={spaceGrotesk.variable}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <TRPCProvider>
            <WalletProvider>{children}</WalletProvider>
          </TRPCProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
