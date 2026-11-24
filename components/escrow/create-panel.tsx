'use client';

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { ArrowUpRight, Check, Circle, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";

import { CREATE_STEPS, checkCreation, creationBlocked, escrowVisible, stepStatus, type CreateStep } from "@/components/escrow/create-flow";
import { friendlyError } from "@/components/friendly-error";
import { trimAmount } from "@/components/listing/format";
import type { TradeView } from "@/components/trade/format";
import { StepFeedback } from "@/components/trade/step-feedback";
import { useChainStep } from "@/components/trade/use-chain-step";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { makeCreationKey } from "@/lib/escrow/creation-key";
import { LAB_FUND_URL, fundWithFriendbot, loadAccount } from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { readPendingTx } from "@/lib/trade/pending-tx";
import type { Signer } from "@/lib/trade/sign-and-submit";

/**
 * The seller's escrow creation (protected trade, state agreed; D2 §7.1).
 * Trustless Work's deploy is signed by a key made in this browser for this
 * one escrow, its admin. The key is never stored and never sent, and it is
 * dropped as soon as it has signed. The seller's own wallet signs nothing
 * here: the USDC goes in at the fund, the next step.
 */
export function CreatePanel({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const preflight = api.escrow.preflight.useQuery({ tradeId: trade.id }, { refetchInterval: 15_000 });
  const prepare = api.escrow.prepareCreate.useMutation();
  const recordCreate = api.escrow.recordCreate.useMutation();
  // FIXES F-15: the signer makeCreationKey() hands out, never a Keypair. Kept
  // for a retry until it has signed the deploy, then dropped.
  const key = useRef<Signer | null>(null);
  // The escrow the prepared deploy creates: the record waits until Soroban RPC shows it.
  const escrowId = useRef<string | null>(null);
  const [at, setAt] = useState<CreateStep | null>(null);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<{ message: string; account: string | null } | null>(null);
  const [signing, setSigning] = useState<{ summary: string; fee: string } | null>(null);
  const step = useChainStep(
    async (txHash) => {
      setAt("record");
      const contractId = escrowId.current ?? trade.escrowContractId;
      if (contractId) await escrowVisible(contractId);
      try {
        await recordCreate.mutateAsync({ tradeId: trade.id, txHash });
      } catch (e) {
        // The background sync may have recorded this very creation first.
        const now = await utils.trade.byId.fetch({ id: trade.id }, { staleTime: 0 });
        if (now.createTx !== txHash) throw e;
      }
      await utils.trade.invalidate();
    },
    { tradeId: trade.id, kind: "create" },
  );

  async function create() {
    // Where it stopped, for the Stellar Lab note; set only through go().
    let stage = "key" as CreateStep;
    const go = (s: CreateStep) => {
      stage = s;
      setAt(s);
    };
    setWorking(true);
    setFailure(null);
    try {
      go("key");
      const signer = (key.current ??= makeCreationKey());
      go("friendbot");
      // A retry keeps the key, whose account may already be open, or funded from Stellar Lab.
      if (!(await loadAccount(signer.publicKey))) await fundWithFriendbot(signer.publicKey);
      go("prepare");
      const prepared = await prepare.mutateAsync({ tradeId: trade.id, admin: signer.publicKey });
      go("check");
      // DECISIONS 7: checked again here, against this trade and this key, before anything is signed.
      const checked = checkCreation(prepared, trade, signer.publicKey);
      if (checked.problems.length) throw new Error(`This browser won't sign it: ${checked.problems.join(" ")}`);
      setSigning({ summary: checked.summary, fee: checked.fee });
      escrowId.current = prepared.contractId;
      go("sign");
      await step.run(signer, async () => TransactionBuilder.fromXDR(prepared.unsignedXdr, NETWORK_PASSPHRASE) as Transaction, {
        summary: checked.summary,
        beforeSubmit: (hash) => {
          // It has signed the one deploy it was made for; nothing else is ever signed with it.
          key.current = null;
          if (hash !== prepared.txHash) throw new Error("The signed creation is not the transaction this page checked. Nothing was sent.");
          go("submit");
        },
      });
    } catch (e) {
      setFailure({
        message: e instanceof Error ? friendlyError(e) : "Something went wrong.",
        account: stage === "friendbot" ? (key.current?.publicKey ?? null) : null,
      });
    } finally {
      setWorking(false);
    }
  }

  const amount = `${trimAmount(trade.amount)} ${trade.asset}`;
  const busy = working || step.busy;
  const pending = readPendingTx(trade.id);
  const blocked = creationBlocked({
    unreported: step.unreported,
    pending,
    preflight: {
      loading: preflight.isLoading,
      error: preflight.error?.message ?? null,
      blockedReason: preflight.data?.blockedReason ?? null,
    },
  });
  // Prepared before this page opened: in this browser before a reload, or in another one.
  const earlier = trade.escrowAdmin !== null && at === null && pending?.kind !== "create";

  return (
    <section className="space-y-10" aria-labelledby="create-heading">
      <div className="space-y-5">
        <p className="eyebrow">Before you fund</p>
        <h2 id="create-heading" className="text-3xl font-semibold tracking-tight">
          Create the escrow for <span className="font-mono font-medium [overflow-wrap:anywhere]">{amount}</span>.
        </h2>
        <p className="border-l-2 border-ink pl-5 text-lg leading-relaxed text-ink">
          A one-time key is made in this browser to create the escrow. It is never sent to Pairy and is dropped once the
          escrow exists.
        </p>
        <p className="text-sm leading-relaxed text-slate">
          Creating it moves none of your {trade.asset}, and your own wallet signs nothing yet. The one-time key&apos;s
          account pays the network fee from Friendbot&apos;s free test XLM. You fund the escrow next, after this page has
          read it back from Stellar testnet.
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="eyebrow">Checklist</p>
          <button
            className="text-xs text-slate underline decoration-slate/40 underline-offset-4 hover:text-ink"
            onClick={() => preflight.refetch()}
          >
            {preflight.isFetching ? "Checking…" : "Check again"}
          </button>
        </div>
        <ul className="space-y-2">
          {preflight.data?.checks.map((c) => (
            <li key={c.id} className="flex gap-3 text-sm">
              {c.ok ? (
                <Check className="mt-0.5 size-4 shrink-0 text-slate" strokeWidth={1.5} aria-label="Done" />
              ) : (
                <X className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-label="Not yet" />
              )}
              <span className={c.ok ? "text-slate" : "font-medium text-ink"}>{c.ok ? c.label : (c.detail ?? c.label)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-3">
        <p className="eyebrow">Steps</p>
        <ol className="space-y-2">
          {CREATE_STEPS.map((s) => {
            const status = stepStatus(s.id, at, failure !== null || step.error !== null);
            return (
              <li key={s.id} data-step={s.id} className="flex gap-3 text-sm" aria-current={status === "now" ? "step" : undefined}>
                {status === "done" ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-slate" strokeWidth={1.5} aria-label="Done" />
                ) : status === "failed" ? (
                  <X className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.5} aria-label="Failed" />
                ) : status === "now" ? (
                  <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-ink" strokeWidth={1.5} aria-label="Running" />
                ) : (
                  <Circle className="mt-0.5 size-4 shrink-0 text-line" strokeWidth={1.5} aria-label="Not yet" />
                )}
                <span className={status === "todo" ? "text-slate" : "text-ink"}>{s.label}</span>
              </li>
            );
          })}
        </ol>
        {signing && (
          <p className="text-sm leading-relaxed text-slate">
            What the one-time key signs: <span className="text-ink">{signing.summary}</span>. Network fee at most{" "}
            <span className="font-mono">{signing.fee} XLM</span>, paid by its own account.
          </p>
        )}
      </div>

      <div className="space-y-3">
        <Button
          variant="beacon"
          size="lg"
          className="h-auto min-h-14 w-full whitespace-normal py-3 [overflow-wrap:anywhere]"
          disabled={!!blocked || busy}
          onClick={create}
        >
          {busy ? "Creating the escrow…" : "Create the escrow"}
        </Button>
        {blocked ? (
          <p className="text-sm text-slate">{blocked}</p>
        ) : (
          earlier && (
            <p className="text-sm text-slate">
              An escrow creation was prepared for this trade before, from this browser or another. If it was sent, this
              page records it once Stellar testnet shows it; if it never was, create the escrow again.
            </p>
          )
        )}
        {failure && (
          <div role="alert" className="space-y-3 rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm text-danger">
            <p className="[overflow-wrap:anywhere]">{failure.message}</p>
            {failure.account && (
              <p className="text-ink">
                You can also fund the one-time account{" "}
                <span className="font-mono [overflow-wrap:anywhere]">{failure.account}</span> on Stellar Lab, then try
                again.{" "}
                <a
                  href={LAB_FUND_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-medium underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
                >
                  Fund it on Stellar Lab
                  <ArrowUpRight strokeWidth={1.5} className="size-4" />
                </a>
              </p>
            )}
          </div>
        )}
        <StepFeedback step={step} />
      </div>
    </section>
  );
}
