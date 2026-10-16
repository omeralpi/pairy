'use client';

import { Account, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Copy, Download } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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

/** G-addresses are 56 characters; groups of four are easier to read aloud and compare. */
const groupAddress = (publicKey: string) => publicKey.match(/.{1,4}/g)?.join(" ") ?? publicKey;

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
        <Skeleton className="h-40 w-full rounded-xl bg-sand" />
      </Page>
    );
  }

  if (!wallet) {
    return (
      <Page>
        <section className="space-y-4 border-t border-line pt-8">
          <h2 className="text-xl font-semibold tracking-tight">No wallet connected.</h2>
          <p className="text-sm text-slate">Make a key on this device, use Freighter, or restore a backup file.</p>
          <Button asChild className="w-full">
            <Link href="/onboard">Get started</Link>
          </Button>
        </section>
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
      toast.success("Friendbot sent 10,000 test XLM.");
    });

  const addTrustline = () =>
    act("trust", async () => {
      const current = await loadAccount(wallet.publicKey);
      if (!current) throw new Error("Get test XLM first.");
      const tx = buildUsdcTrustlineTransaction(new Account(current.accountId(), current.sequenceNumber()));
      const signed = await wallet.signTransaction(tx.toXDR());
      const res = await submit(TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE) as Transaction);
      await account.refetch();
      toast.success("This wallet can now hold USDC.", {
        action: { label: "Receipt", onClick: () => window.open(explorerTxUrl(res.hash), "_blank", "noopener") },
      });
    });

  const signOut = () =>
    act("logout", async () => {
      await logout();
      await disconnect();
      router.push("/onboard");
    });

  const backup = () => exportBackup().catch((e) => toast.error(message(e)));

  const acct = account.data;

  return (
    <Page kind={wallet.kind === "freighter" ? "Freighter" : "Key on this device"}>
      {justCreated && wallet.kind === "device" && <BackupPanel title="Export a backup now." onExport={backup} />}

      {sessionKey !== wallet.publicKey && (
        <div role="alert" className="border-l-2 border-danger pl-4 text-sm">
          <p className="font-semibold text-danger">Not signed in with this wallet.</p>
          <p className="text-ink">
            <Link href="/onboard" className="underline decoration-ink/30 underline-offset-4 hover:decoration-ink">
              Sign in
            </Link>{" "}
            to list and trade.
          </p>
        </div>
      )}

      <section className="space-y-3">
        <p className="eyebrow">Address</p>
        <p className="font-mono text-base leading-relaxed text-ink">{groupAddress(wallet.publicKey)}</p>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-ink hover:text-deep"
            onClick={() => navigator.clipboard.writeText(wallet.publicKey).then(() => toast.success("Address copied."))}
          >
            <Copy strokeWidth={1.5} className="size-4" />
            Copy
          </button>
          <a
            href={explorerAccountUrl(wallet.publicKey)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
          >
            View on stellar.expert
            <ArrowUpRight strokeWidth={1.5} className="size-4" />
          </a>
        </div>
      </section>

      <section className="space-y-6 border-t border-line pt-8">
        {account.isLoading ? (
          <Skeleton className="h-24 w-full bg-sand" />
        ) : account.error ? (
          <p className="text-sm text-danger">Couldn&apos;t reach the Stellar testnet: {message(account.error)}</p>
        ) : !acct ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="font-semibold">This wallet isn&apos;t on testnet yet.</h2>
              <p className="text-sm text-slate">
                Friendbot, the test network&apos;s faucet, opens it with 10,000 test XLM. It&apos;s free testnet money
                and worth nothing.
              </p>
            </div>
            <Button className="w-full" disabled={busy !== null} onClick={fund}>
              {busy === "fund" ? "Asking Friendbot…" : "Get 10,000 test XLM"}
            </Button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 divide-x divide-line">
              <Balance code="XLM" amount={balanceOf(acct, "XLM")} />
              <Balance code="USDC" amount={hasTrustline(acct, "USDC") ? balanceOf(acct, "USDC") : null} />
            </div>
            {!hasTrustline(acct, "USDC") && (
              <div className="space-y-3 border-t border-line pt-6">
                <p className="text-sm text-slate">
                  To receive test USDC in a trade, this wallet has to accept it first. That reserves 0.5 XLM of your
                  balance.
                </p>
                <Button className="w-full" disabled={busy !== null} onClick={addTrustline}>
                  {busy === "trust" ? "Waiting for your signature…" : "Add USDC to this wallet"}
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      {wallet.kind === "device" && !justCreated && <BackupPanel title="Keep a backup." onExport={backup} />}

      <section className="space-y-2 border-t border-line pt-6">
        <button
          type="button"
          disabled={busy !== null}
          onClick={signOut}
          className="text-sm text-slate underline-offset-4 hover:text-ink hover:underline disabled:opacity-50"
        >
          {busy === "logout" ? "Logging out…" : "Log out"}
        </button>
        {wallet.kind === "device" && (
          <p className="text-xs text-slate">
            Logging out keeps the locked key in this browser. You can sign back in with your pincode.
          </p>
        )}
      </section>
    </Page>
  );
}

function Page({ kind, children }: { kind?: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-md space-y-10 px-4 py-10 md:py-16">
      <header className="space-y-3">
        <p className="eyebrow">{kind ? `Wallet · ${kind} · testnet` : "Wallet · testnet"}</p>
        <h1 className="text-4xl font-bold leading-[1.05] tracking-tight">
          Your <em className="font-serif font-normal italic">wallet.</em>
        </h1>
      </header>
      {children}
    </div>
  );
}

function BackupPanel({ title, onExport }: { title: string; onExport: () => void }) {
  return (
    <section className="space-y-4 rounded-xl bg-sand p-5">
      <div className="space-y-2">
        <p className="eyebrow">Backup</p>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-sm text-ink">
          This key lives only in this browser and Pairy keeps no copy. If you lose this device or forget the pincode
          without a backup, the wallet is gone.
        </p>
        <p className="text-sm text-slate">
          The file is locked with your pincode, so keep both. Use it to restore the wallet in another browser.
        </p>
      </div>
      <Button className="w-full" onClick={onExport}>
        <Download strokeWidth={1.5} />
        Export backup
      </Button>
    </section>
  );
}

function Balance({ code, amount }: { code: string; amount: string | null }) {
  return (
    <div className="space-y-2 px-4 first:pl-0 last:pr-0">
      <p className="eyebrow">{code}</p>
      {/* en-US so "9,979.99" never reads as a Turkish 9.979,99; the full 7-decimal balance is in the title. */}
      <p
        className="whitespace-nowrap font-mono text-2xl tabular-nums text-ink sm:text-3xl"
        title={amount ?? undefined}
      >
        {amount === null
          ? "None"
          : Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </p>
      {amount === null && <p className="text-xs text-slate">Not added yet</p>}
    </div>
  );
}
