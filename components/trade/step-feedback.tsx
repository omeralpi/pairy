'use client';

import Link from "next/link";

import { shortAddress } from "@/components/listing/format";
import type { useChainStep } from "@/components/trade/use-chain-step";
import { Button } from "@/components/ui/button";
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
    <p className="text-sm text-slate">
      {problem}{" "}
      {problem.startsWith("Connect") && (
        <Link href="/wallet" className="font-medium text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink">
          Open wallet
        </Link>
      )}
    </p>
  );
}

export function StepFeedback({ step }: { step: ReturnType<typeof useChainStep> }) {
  if (!step.error) return null;
  return (
    <div role="alert" className="space-y-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
      <p className="[overflow-wrap:anywhere]">{step.error}</p>
      {step.unreported && (
        <div className="flex flex-wrap items-center gap-4">
          <a
            href={explorerTxUrl(step.unreported)}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-xs text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
          >
            Receipt ↗
          </a>
          <Button variant="outline" size="sm" disabled={step.busy} onClick={step.retry}>
            Retry recording
          </Button>
        </div>
      )}
    </div>
  );
}
