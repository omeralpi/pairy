'use client';

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { READING, UNREADABLE, checkPrepared, fundBlocked, readEscrowOnChain, termRows } from "@/components/escrow/escrow-steps";
import { TermCheckList } from "@/components/escrow/term-check-list";
import { friendlyError } from "@/components/friendly-error";
import { trimAmount } from "@/components/listing/format";
import type { TradeView } from "@/components/trade/format";
import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { useChainStep } from "@/components/trade/use-chain-step";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { expectedTerms } from "@/lib/escrow/terms";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { readPendingTx } from "@/lib/trade/pending-tx";
import { useWallet } from "@/lib/wallet/use-wallet";

/**
 * The seller's fund (protected trade, state escrow_created; D2 §7.1, §7.3).
 * This browser reads the escrow from Stellar testnet and checks every term
 * against the trade, checks Trustless Work's fund transaction the same way,
 * and only then asks the seller's own wallet to sign it.
 */
export function FundPanel({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const { wallet, ready } = useWallet();
  // escrow_created: both were recorded from the chain with the creation.
  const contractId = trade.escrowContractId!;
  const expected = expectedTerms({ buyer: trade.buyer, seller: trade.seller, amount: trade.amount, escrowAdmin: trade.escrowAdmin! });
  const read = useQuery({ queryKey: ["escrow-on-chain", contractId], queryFn: () => readEscrowOnChain(contractId) });
  const preflight = api.escrow.preflight.useQuery({ tradeId: trade.id }, { refetchInterval: 15_000 });
  const prepare = api.escrow.prepareFund.useMutation();
  const recordFund = api.escrow.recordFund.useMutation();
  const [ack, setAck] = useState(false);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [signing, setSigning] = useState<{ summary: string; fee: string } | null>(null);
  const step = useChainStep(
    async (txHash) => {
      try {
        await recordFund.mutateAsync({ tradeId: trade.id, txHash });
      } catch (e) {
        // The background sync may have recorded this very fund first.
        const now = await utils.trade.byId.fetch({ id: trade.id }, { staleTime: 0 });
        if (now.fundTx !== txHash) throw e;
      }
      await utils.trade.invalidate();
    },
    { tradeId: trade.id, kind: "fund" },
    "USDC",
  );

  async function fund() {
    if (!wallet) return;
    setWorking(true);
    setFailure(null);
    try {
      const prepared = await prepare.mutateAsync({ tradeId: trade.id });
      // DECISIONS 7: checked again here, expected_escrow included (G25), before the wallet opens.
      const checked = checkPrepared(prepared, {
        kind: "fund",
        contractId,
        seller: trade.seller,
        amountStroops: expected.amountStroops,
        terms: expected,
      });
      if (checked.problems.length) throw new Error(`This browser won't sign it: ${checked.problems.join(" ")}`);
      setSigning({ summary: checked.summary, fee: checked.fee });
      await step.run(wallet, async () => TransactionBuilder.fromXDR(prepared.unsignedXdr, NETWORK_PASSPHRASE) as Transaction, {
        summary: checked.summary,
        // The buyer may have cancelled, or the escrow changed, while the wallet was open (lock-panel.tsx).
        beforeSubmit: async (hash) => {
          if (hash !== prepared.txHash) throw new Error("The signed fund is not the transaction this page checked. Nothing was sent.");
          const [now, again] = await Promise.all([utils.trade.byId.fetch({ id: trade.id }, { staleTime: 0 }), readEscrowOnChain(contractId)]);
          const problems = termRows(again, expected).flatMap((r) => (r.problem ? [r.problem] : []));
          const stop =
            now.state !== "escrow_created" || now.fundTx !== null
              ? "This trade changed while you were signing. Nothing was sent."
              : problems.length
                ? `Don't fund this escrow: ${problems.join(" ")} Nothing was sent.`
                : null;
          if (stop) {
            void utils.trade.invalidate();
            void read.refetch();
            throw new Error(stop);
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
  const rows = read.data ? termRows(read.data, expected) : undefined;
  const problem = walletProblem(wallet, ready, trade.seller);
  const blocked = fundBlocked({
    unreported: step.unreported,
    pending: readPendingTx(trade.id),
    read: { loading: read.isLoading, failed: !!read.error, rows },
    preflight: {
      loading: preflight.isLoading,
      error: preflight.error?.message ?? null,
      blockedReason: preflight.data?.blockedReason ?? null,
    },
    acknowledged: ack,
    wallet: problem,
  });
  const busy = working || step.busy;

  return (
    <section className="space-y-10" aria-labelledby="fund-heading">
      <div className="space-y-5">
        <p className="eyebrow">Before you fund</p>
        <h2 id="fund-heading" className="text-3xl font-semibold tracking-tight">
          Fund the escrow with <span className="font-mono font-medium [overflow-wrap:anywhere]">{amount}</span>.
        </h2>
        <p className="border-l-2 border-ink pl-5 text-lg leading-relaxed text-ink">
          Your {amount} goes into the escrow, not to the buyer. Check its terms below first: this page read them from
          Stellar testnet itself.
        </p>
      </div>

      {rows ? (
        <TermCheckList rows={rows} viewerUrl={trade.viewerUrl} />
      ) : read.error ? (
        <div className="space-y-3">
          <p className="text-sm text-ink">{UNREADABLE}</p>
          <Button variant="outline" size="sm" disabled={read.isFetching} onClick={() => read.refetch()}>
            Read it again
          </Button>
        </div>
      ) : (
        <p className="text-sm text-slate">{READING}</p>
      )}

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 text-sm leading-relaxed">
        <input type="checkbox" className="mt-1 size-4 shrink-0 accent-ink" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>
          I understand the buyer is paid only when I release or the arbiter decides; a dispute I leave unanswered for 24
          hours pays the buyer if the buyer says yes.
        </span>
      </label>

      <div className="space-y-3">
        <Button
          variant="beacon"
          size="lg"
          className="h-auto min-h-14 w-full whitespace-normal py-3 [overflow-wrap:anywhere]"
          disabled={!!blocked || busy}
          onClick={fund}
        >
          {busy ? "Signing and sending…" : `Fund ${amount}`}
        </Button>
        {blocked && blocked === problem ? (
          <WalletHint problem={problem} />
        ) : (
          // The escrow's read state is already said where its terms go.
          blocked && blocked !== READING && blocked !== UNREADABLE && <p className="text-sm text-slate">{blocked}</p>
        )}
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
