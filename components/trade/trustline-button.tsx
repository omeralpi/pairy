'use client';

import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { useChainStep } from "@/components/trade/use-chain-step";
import { Button } from "@/components/ui/button";
import { ASSETS, type AssetCode } from "@/lib/stellar/assets";
import { networkDeadline } from "@/lib/stellar/horizon";
import { buildTrustlineTransaction } from "@/lib/stellar/trustline";
import { loadSourceAccount } from "@/lib/trade/sign-and-submit";
import { useWallet } from "@/lib/wallet/use-wallet";

/** The buyer adds the trustline the claim needs (else op_no_trust). */
export function TrustlineButton({
  asset,
  buyer,
  locked = false,
  onDone,
}: {
  asset: AssetCode;
  buyer: string;
  /** The seller has already locked; the trustline is now needed for the claim itself. */
  locked?: boolean;
  onDone: () => unknown;
}) {
  const { wallet, ready } = useWallet();
  const step = useChainStep(async () => onDone(), undefined, asset);
  const problem = walletProblem(wallet, ready, buyer);
  const { label } = ASSETS[asset];

  return (
    <div className="space-y-3 rounded-xl bg-sand p-5">
      <p className="text-sm leading-relaxed text-ink">
        {locked
          ? `Add ${label} to your wallet so your claim can go through.`
          : `Add ${label} to your wallet before the seller locks it for you. Without it, your claim can't go through.`}{" "}
        It sets aside 0.5 XLM in your wallet as a reserve.
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={!!problem || step.busy}
        onClick={() =>
          wallet &&
          step.run(wallet, async () =>
            buildTrustlineTransaction(await loadSourceAccount(wallet.publicKey), asset, await networkDeadline(300)),
          )
        }
      >
        {step.busy ? "Waiting for your signature…" : `Add ${label} to my wallet`}
      </Button>
      <WalletHint problem={problem} />
      <StepFeedback step={step} />
    </div>
  );
}
