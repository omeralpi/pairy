'use client';

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { Flag } from "lucide-react";
import { useState } from "react";

import { ConfirmAction } from "@/components/confirm-action";
import { checkPrepared, disputeBlocked, readEscrowOnChain } from "@/components/escrow/escrow-steps";
import { friendlyError } from "@/components/friendly-error";
import type { TradeView } from "@/components/trade/format";
import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { useChainStep } from "@/components/trade/use-chain-step";
import { api } from "@/lib/api";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { readPendingTx } from "@/lib/trade/pending-tx";
import { useWallet } from "@/lib/wallet/use-wallet";

/** What signing a dispute does, said before the wallet opens (D2 §7.3, word for word). */
const DIALOG =
  "This signs a dispute on the escrow. From then on only the arbiter can move the USDC, by the published rule. The reason written on chain is a fixed sentence. Each of you gets 24 hours to answer one question. Trustless Work keeps 0.3% of any exit; the arbiter acts within 72 hours.";

/**
 * "Flag a problem" on a funded protected trade (D2 §7.2, §7.3): either trader
 * signs a dispute on the escrow in their own wallet, with Pairy's fixed
 * reason. Shown only while the escrow is funded and not disputed; before
 * funding there is nothing on chain to dispute (MC-34).
 */
export function EscrowDisputeButton({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const { wallet, ready } = useWallet();
  // funded: recorded from the chain with the creation.
  const contractId = trade.escrowContractId!;
  const me = trade.role === "seller" ? trade.seller : trade.buyer;
  const prepare = api.escrow.prepareDispute.useMutation();
  const recordDispute = api.escrow.recordDispute.useMutation();
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [signing, setSigning] = useState<{ summary: string; fee: string } | null>(null);
  const step = useChainStep(
    async (txHash) => {
      try {
        await recordDispute.mutateAsync({ tradeId: trade.id, txHash });
      } catch (e) {
        // The background sync, or the other trader's page, may have recorded this very dispute first.
        const now = await utils.trade.byId.fetch({ id: trade.id }, { staleTime: 0 });
        if (now.disputeTx !== txHash) throw e;
      }
      await utils.trade.invalidate();
    },
    { tradeId: trade.id, kind: "dispute" },
    "USDC",
  );
  const problem = walletProblem(wallet, ready, me);

  async function dispute() {
    if (!wallet || problem) return;
    setWorking(true);
    setFailure(null);
    try {
      const prepared = await prepare.mutateAsync({ tradeId: trade.id });
      // DECISIONS 7: checked again here, against this trade, before the wallet opens.
      const checked = checkPrepared(prepared, { kind: "dispute", contractId, signer: me });
      if (checked.problems.length) throw new Error(`This browser won't sign it: ${checked.problems.join(" ")}`);
      setSigning({ summary: checked.summary, fee: checked.fee });
      await step.run(wallet, async () => TransactionBuilder.fromXDR(prepared.unsignedXdr, NETWORK_PASSPHRASE) as Transaction, {
        summary: checked.summary,
        // A dispute (the other trader's) or a release may have landed while the wallet was open: this one
        // would then fail on chain, at this trader's cost.
        beforeSubmit: async (hash) => {
          if (hash !== prepared.txHash) throw new Error("The signed dispute is not the transaction this page checked. Nothing was sent.");
          const [now, again] = await Promise.all([utils.trade.byId.fetch({ id: trade.id }, { staleTime: 0 }), readEscrowOnChain(contractId)]);
          const s = again.status;
          if (now.state !== "funded" || now.disputed || now.releaseTx !== null || s.disputed || s.released || s.resolved) {
            void utils.trade.invalidate();
            throw new Error("This escrow is no longer open to a dispute: a dispute or a settlement reached it first. Nothing was sent.");
          }
        },
      });
    } catch (e) {
      setFailure(e instanceof Error ? friendlyError(e) : "Something went wrong.");
    } finally {
      setWorking(false);
    }
  }

  const blocked = disputeBlocked({ unreported: step.unreported, pending: readPendingTx(trade.id), wallet: problem });
  const busy = working || step.busy;

  return (
    <div className="space-y-3">
      <ConfirmAction title="Open a dispute on the escrow?" description={DIALOG} confirmLabel="Sign the dispute" onConfirm={dispute}>
        <button
          className="inline-flex items-center gap-1.5 text-xs text-slate underline decoration-slate/40 underline-offset-4 hover:text-ink disabled:no-underline disabled:opacity-60"
          disabled={!!blocked || busy}
        >
          <Flag className="size-3.5" strokeWidth={1.5} /> {busy ? "Signing the dispute…" : "Flag a problem"}
        </button>
      </ConfirmAction>
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
  );
}
