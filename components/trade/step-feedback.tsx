'use client';

import Link from "next/link";

import { shortAddress } from "@/components/listing/format";
import { btnSecondary } from "@/components/trade/format";
import type { useChainStep } from "@/components/trade/use-chain-step";
import { explorerTxUrl } from "@/lib/stellar/horizon";
import type { Wallet } from "@/lib/wallet/use-wallet";

/** Why `wallet` cannot sign for `account`, or null when it can. */
export function walletProblem(wallet: Wallet | null, ready: boolean, account: string): string | null {
  if (!ready) return "Loading your wallet…";
  if (!wallet) return "Connect your wallet to sign.";
  if (wallet.publicKey !== account) {
    return `The connected wallet is ${shortAddress(wallet.publicKey)}, but this step must be signed by ${shortAddress(account)}.`;
  }
  return null;
}

export function WalletHint({ problem }: { problem: string | null }) {
  if (!problem) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {problem}{" "}
      {problem.startsWith("Connect") && (
        <Link href="/wallet" className="font-semibold text-pairy-flame underline">
          Open wallet
        </Link>
      )}
    </p>
  );
}

export function StepFeedback({ step }: { step: ReturnType<typeof useChainStep> }) {
  if (!step.error) return null;
  return (
    <div role="alert" className="space-y-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
      <p>{step.error}</p>
      {step.unreported && (
        <div className="flex flex-wrap items-center gap-3">
          <a href={explorerTxUrl(step.unreported)} target="_blank" rel="noreferrer" className="underline">
            View transaction
          </a>
          <button className={btnSecondary} disabled={step.busy} onClick={step.retry}>
            Retry recording
          </button>
        </div>
      )}
    </div>
  );
}
