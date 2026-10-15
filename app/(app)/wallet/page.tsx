'use client';

import { Account, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { useQuery } from "@tanstack/react-query";
import { Copy, Download, ExternalLink, LogOut } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLogin } from "@/lib/auth/use-login";
import { useSession } from "@/lib/auth/use-session";
import {
  balanceOf,
  explorerAccountUrl,
  explorerTxUrl,
  fundWithFriendbot,
  hasTrustline,
  loadAccount,
  submit,
} from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { buildUsdcTrustlineTransaction } from "@/lib/stellar/trustline";
import { useWalletContext } from "@/lib/wallet/use-wallet";

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

export default function WalletPage() {
  const router = useRouter();
  const { wallet, ready, exportBackup, disconnect } = useWalletContext();
  const { publicKey: sessionKey, loading: sessionLoading } = useSession();
  const { logout } = useLogin();
  const [busy, setBusy] = useState<null | "fund" | "trust" | "logout">(null);
  const [justCreated, setJustCreated] = useState(false);

  useEffect(() => {
    setJustCreated(new URLSearchParams(window.location.search).has("new"));
  }, []);

  const account = useQuery({
    queryKey: ["horizon-account", wallet?.publicKey],
    queryFn: () => loadAccount(wallet!.publicKey),
    enabled: !!wallet,
  });

  if (!ready || sessionLoading) {
    return (
      <Page>
        <Skeleton className="h-40 w-full rounded-xl" />
      </Page>
    );
  }

  if (!wallet) {
    return (
      <Page>
        <Card>
          <CardHeader>
            <CardTitle>No wallet connected</CardTitle>
            <CardDescription>Connect Freighter, create a wallet on this device, or import a backup.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/onboard">Get started</Link>
            </Button>
          </CardContent>
        </Card>
      </Page>
    );
  }

  const act = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(null);
    }
  };

  const fund = () =>
    act("fund", async () => {
      await fundWithFriendbot(wallet.publicKey);
      await account.refetch();
      toast.success("Funded with testnet XLM by Friendbot.");
    });

  const addTrustline = () =>
    act("trust", async () => {
      const current = await loadAccount(wallet.publicKey);
      if (!current) throw new Error("Fund the account first.");
      const tx = buildUsdcTrustlineTransaction(new Account(current.accountId(), current.sequenceNumber()));
      const signed = await wallet.signTransaction(tx.toXDR());
      const res = await submit(TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE) as Transaction);
      await account.refetch();
      toast.success("USDC trustline added.", {
        action: { label: "View", onClick: () => window.open(explorerTxUrl(res.hash), "_blank", "noopener") },
      });
    });

  const signOut = () =>
    act("logout", async () => {
      await logout();
      await disconnect();
      router.push("/onboard");
    });

  const acct = account.data;

  return (
    <Page>
      {justCreated && wallet.kind === "device" && (
        <Alert>
          <AlertTitle>Export a backup now</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              This wallet lives only in this browser. Without a backup file, losing this device or the pincode loses
              the wallet. The file is encrypted with your pincode, so keep both.
            </p>
            <Button size="sm" onClick={() => exportBackup().catch((e) => toast.error(message(e)))}>
              <Download className="mr-1.5 size-4" />
              Export backup
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {sessionKey !== wallet.publicKey && (
        <Alert variant="destructive">
          <AlertTitle>Not signed in with this wallet</AlertTitle>
          <AlertDescription>
            <Link href="/onboard" className="underline">
              Sign in
            </Link>{" "}
            to list and trade.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Your wallet</CardTitle>
            <Badge variant="outline">{wallet.kind === "freighter" ? "Freighter" : "On this device"}</Badge>
          </div>
          <p className="break-all font-mono text-sm">{wallet.publicKey}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigator.clipboard.writeText(wallet.publicKey).then(() => toast.success("Address copied."))}
            >
              <Copy className="mr-1.5 size-4" />
              Copy
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href={explorerAccountUrl(wallet.publicKey)} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1.5 size-4" />
                stellar.expert
              </a>
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {account.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : account.error ? (
            <p className="text-sm text-destructive">Couldn&apos;t reach Horizon: {message(account.error)}</p>
          ) : !acct ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                This account doesn&apos;t exist on testnet yet. Friendbot, the network&apos;s free testnet faucet, can
                create it with 10,000 test XLM.
              </p>
              <Button className="w-full" disabled={busy !== null} onClick={fund}>
                {busy === "fund" ? "Funding…" : "Fund with Friendbot"}
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Balance code="XLM" amount={balanceOf(acct, "XLM")} />
                <Balance code="USDC" amount={hasTrustline(acct, "USDC") ? balanceOf(acct, "USDC") : null} />
              </div>
              {!hasTrustline(acct, "USDC") && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    To receive testnet USDC in a trade, your account needs a USDC trustline. It reserves 0.5 XLM.
                  </p>
                  <Button className="w-full" disabled={busy !== null} onClick={addTrustline}>
                    {busy === "trust" ? "Waiting for signature…" : "Add USDC trustline"}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {wallet.kind === "device" && !justCreated && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Backup</CardTitle>
            <CardDescription>
              Download this wallet as a file encrypted with your pincode, to restore it in another browser. Pairy keeps
              no copy, so this file and your pincode are the only way back in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" className="w-full" onClick={() => exportBackup().catch((e) => toast.error(message(e)))}>
              <Download className="mr-1.5 size-4" />
              Export backup
            </Button>
          </CardContent>
        </Card>
      )}

      <Button variant="outline" className="w-full" disabled={busy !== null} onClick={signOut}>
        <LogOut className="mr-1.5 size-4" />
        {busy === "logout" ? "Logging out…" : "Log out"}
      </Button>
      {wallet.kind === "device" && (
        <p className="text-center text-xs text-muted-foreground">
          Logging out keeps the encrypted wallet in this browser. You can sign back in with your pincode.
        </p>
      )}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-md space-y-4 px-4 py-6 md:py-10">{children}</div>;
}

function Balance({ code, amount }: { code: string; amount: string | null }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{code}</p>
      <p className="mt-1 font-mono text-lg">{amount === null ? "—" : Number(amount).toLocaleString(undefined, { maximumFractionDigits: 7 })}</p>
      {amount === null && <p className="text-xs text-muted-foreground">No trustline</p>}
    </div>
  );
}
