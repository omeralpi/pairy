import { AppShell } from "@/components/app-shell";
import { PrivyLayerDynamic } from "@/components/providers/privy-layer-dynamic";
import { WalletProvider } from "@/components/providers/wallet-provider";

// The wallet providers are mounted here, not in the root layout, so the landing
// page never loads them or Privy (DECISIONS 4). PrivyLayer renders nothing; it
// hands its adapter to WalletProvider through context once its chunk arrives.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <WalletProvider>
      <PrivyLayerDynamic />
      <AppShell>{children}</AppShell>
    </WalletProvider>
  );
}
