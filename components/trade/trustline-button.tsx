'use client';

import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { useChainStep } from "@/components/trade/use-chain-step";
import { Button } from "@/components/ui/button";
import { buildUsdcTrustlineTransaction } from "@/lib/stellar/trustline";
import { loadSourceAccount } from "@/lib/trade/sign-and-submit";
import { useWallet } from "@/lib/wallet/use-wallet";

/** The buyer adds the USDC trustline the claim needs (else op_no_trust). */
export function TrustlineButton({ buyer, onDone }: { buyer: string; onDone: () => unknown }) {
  const { wallet, ready } = useWallet();
  const step = useChainStep(async () => onDone());
  const problem = walletProblem(wallet, ready, buyer);

  return (
    <div className="space-y-3 rounded-xl bg-sand p-5">
      <p className="text-sm leading-relaxed text-ink">
        Add USDC to your wallet before the seller locks it for you. Without it, your claim can&apos;t go through. It
        sets aside 0.5 XLM in your wallet as a reserve.
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={!!problem || step.busy}
        onClick={() =>
          wallet &&
          step.run(wallet, async () => buildUsdcTrustlineTransaction(await loadSourceAccount(wallet.publicKey)))
        }
      >
        {step.busy ? "Waiting for your signature…" : "Add USDC to my wallet"}
      </Button>
      <WalletHint problem={problem} />
      <StepFeedback step={step} />
    </div>
  );
}
