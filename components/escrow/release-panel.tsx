'use client';

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { useState } from "react";

import { checkPrepared, readEscrowOnChain, releaseBlocked } from "@/components/escrow/escrow-steps";
import { friendlyError } from "@/components/friendly-error";
import { trimAmount } from "@/components/listing/format";
import type { TradeView } from "@/components/trade/format";
import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { useChainStep } from "@/components/trade/use-chain-step";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { netAfterFee } from "@/lib/escrow/fee";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { fromStroops, toStroops } from "@/lib/trade/amount";
import { readPendingTx } from "@/lib/trade/pending-tx";
import { useWallet } from "@/lib/wallet/use-wallet";

/**
 * The seller's release (protected trade, funded, no dispute; D2 §7.3). One
 * signature from the seller's own wallet pays the buyer the escrow less
 * Trustless Work's 0.3% (FIXES F-20: no milestone step).
 */
export function ReleasePanel({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const { wallet, ready } = useWallet();
  // funded: recorded from the chain with the creation.
  const contractId = trade.escrowContractId!;
  const prepare = api.escrow.prepareRelease.useMutation();
  const recordRelease = api.escrow.recordRelease.useMutation();
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [signing, setSigning] = useState<{ summary: string; fee: string } | null>(null);
  const step = useChainStep(
    async (txHash) => {
      try {
        await recordRelease.mutateAsync({ tradeId: trade.id, txHash });
      } catch (e) {
        // The background sync may have recorded this very release first.
        const now = await utils.trade.byId.fetch({ id: trade.id }, { staleTime: 0 });
        if (now.releaseTx !== txHash) throw e;
      }
      await utils.trade.invalidate();
    },
    { tradeId: trade.id, kind: "release" },
    "USDC",
  );

  async function release() {
    if (!wallet) return;
    setWorking(true);
    setFailure(null);
    try {
      const prepared = await prepare.mutateAsync({ tradeId: trade.id });
      // DECISIONS 7: checked again here, against this trade, before the wallet opens.
      const checked = checkPrepared(prepared, { kind: "release", contractId, seller: trade.seller });
      if (checked.problems.length) throw new Error(`This browser won't sign it: ${checked.problems.join(" ")}`);
      setSigning({ summary: checked.summary, fee: checked.fee });
      await step.run(wallet, async () => TransactionBuilder.fromXDR(prepared.unsignedXdr, NETWORK_PASSPHRASE) as Transaction, {
        summary: checked.summary,
        // A dispute may have landed while the wallet was open: the release would fail on chain, at the seller's cost (O-24).
        beforeSubmit: async (hash) => {
          if (hash !== prepared.txHash) throw new Error("The signed release is not the transaction this page checked. Nothing was sent.");
          const [now, again] = await Promise.all([utils.trade.byId.fetch({ id: trade.id }, { staleTime: 0 }), readEscrowOnChain(contractId)]);
          const s = again.status;
          if (now.state !== "funded" || now.disputed || now.releaseTx !== null || s.disputed || s.released || s.resolved) {
            void utils.trade.invalidate();
            throw new Error("This escrow is no longer waiting for its release: a dispute or a settlement reached it first. Nothing was sent.");
          }
        },
      });
    } catch (e) {
      setFailure(e instanceof Error ? friendlyError(e) : "Something went wrong.");
    } finally {
      setWorking(false);
    }
  }

  const amount = `${trimAmount(trade.amount)} ${trade.asset}`;
  const net = fromStroops(netAfterFee(toStroops(trade.amount)));
  const problem = walletProblem(wallet, ready, trade.seller);
  const blocked = releaseBlocked({ unreported: step.unreported, pending: readPendingTx(trade.id), wallet: problem });
  const busy = working || step.busy;

  return (
    <section className="space-y-10" aria-labelledby="release-heading">
      <div className="space-y-5">
        <p className="eyebrow">At the meeting</p>
        <h2 id="release-heading" className="text-3xl font-semibold tracking-tight">
          Release the escrow to the buyer.
        </h2>
        <p className="border-l-2 border-ink pl-5 text-lg leading-relaxed text-ink">
          {`Release only when you hold the cash. The buyer receives ${net} USDC; 0.3% goes to Trustless Work.`}
        </p>
        {/* trade.byId sets it once funded_at + 72 h has passed with no release or dispute. */}
        {trade.stallNudge && (
          <p className="text-sm leading-relaxed text-ink">If the buyer never came, open a dispute: it&apos;s the way to a refund.</p>
        )}
      </div>

      <div className="space-y-3">
        <Button
          variant="beacon"
          size="lg"
          className="h-auto min-h-14 w-full whitespace-normal py-3 [overflow-wrap:anywhere]"
          disabled={!!blocked || busy}
          onClick={release}
        >
          {busy ? "Signing and sending…" : `Release ${amount}`}
        </Button>
        {blocked && blocked === problem ? <WalletHint problem={problem} /> : blocked && <p className="text-sm text-slate">{blocked}</p>}
        {signing && (
          <p className="text-sm leading-relaxed text-slate">
            What your wallet signs: <span className="text-ink">{signing.summary}</span>. Network fee at most{" "}
            <span className="font-mono">{signing.fee} XLM</span>.
          </p>
        )}
        {failure && (
          <p role="alert" className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger [overflow-wrap:anywhere]">
            {failure}
          </p>
        )}
        <StepFeedback step={step} />
      </div>
    </section>
  );
}
