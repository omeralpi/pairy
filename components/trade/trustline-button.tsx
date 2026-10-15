'use client';

import { btnSecondary } from "@/components/trade/format";
import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { useChainStep } from "@/components/trade/use-chain-step";
import { buildUsdcTrustlineTransaction } from "@/lib/stellar/trustline";
import { loadSourceAccount } from "@/lib/trade/sign-and-submit";
import { useWallet } from "@/lib/wallet/use-wallet";

/** The buyer adds the USDC trustline the claim needs (else op_no_trust). */
export function TrustlineButton({ buyer, onDone }: { buyer: string; onDone: () => unknown }) {
  const { wallet, ready } = useWallet();
  const step = useChainStep(async () => onDone());
  const problem = walletProblem(wallet, ready, buyer);

  return (
    <div className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
      <p className="text-sm">
        You need a USDC trustline before the seller can lock USDC for you. Without it the network refuses your claim
        (<code>op_no_trust</code>). Adding it costs a 0.5 XLM reserve on your account.
      </p>
      <button
        className={btnSecondary}
        disabled={!!problem || step.busy}
        onClick={() =>
          wallet &&
          step.run(wallet, async () => buildUsdcTrustlineTransaction(await loadSourceAccount(wallet.publicKey)))
        }
      >
        {step.busy ? "Waiting for signature…" : "Add USDC trustline"}
      </button>
      <WalletHint problem={problem} />
      <StepFeedback step={step} />
    </div>
  );
}
