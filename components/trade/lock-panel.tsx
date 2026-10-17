'use client';

import { Check, Download, X } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { shortAddress, trimAmount } from "@/components/listing/format";
import { windowLabel, type TradeView } from "@/components/trade/format";
import { lockGuard, unrecordedLock } from "@/components/trade/guards";
import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { useChainStep } from "@/components/trade/use-chain-step";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { toAsset } from "@/lib/stellar/assets";
import { networkDeadline } from "@/lib/stellar/horizon";
import { buildLockTransaction } from "@/lib/stellar/settlement";
import { readPendingTx } from "@/lib/trade/pending-tx";
import type { PreflightCheck } from "@/lib/trade/preflight";
import { loadSourceAccount } from "@/lib/trade/sign-and-submit";
import { lockBackupProblem } from "@/lib/wallet/backup";
import { useWalletContext } from "@/lib/wallet/use-wallet";

/** Plain words for a check; the trustline one would otherwise say "op_no_trust". */
function checkText(c: PreflightCheck, asset: string): string {
  if (c.id === "buyerTrustline") {
    return c.ok ? `The buyer can receive ${asset}` : `The buyer needs to add ${asset} to their wallet first.`;
  }
  return c.ok ? c.label : (c.detail ?? c.label);
}

/** The seller's lock screen (state agreed). */
export function LockPanel({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const { wallet, ready, exportBackup } = useWalletContext();
  const [ack, setAck] = useState(false);
  const [exported, setExported] = useState(false);
  const preflight = api.trade.lockPreflight.useQuery({ tradeId: trade.id }, { refetchInterval: 15_000 });
  const recordLock = api.trade.recordLock.useMutation();
  const { mutate: sync } = api.trade.sync.useMutation({ onSuccess: () => utils.trade.invalidate() });
  const step = useChainStep(
    async (txHash) => {
      try {
        await recordLock.mutateAsync({ tradeId: trade.id, txHash });
      } catch (e) {
        // The background sync may have recorded this very lock first.
        const now = await utils.trade.byId.fetch({ id: trade.id }, { staleTime: 0 });
        if (now.lockTx !== txHash) throw e;
      }
      await utils.trade.invalidate();
    },
    { tradeId: trade.id, kind: "lock" },
  );
  const alreadyLocked = preflight.data?.checks.find((c) => c.id === "noExistingLock" && !c.ok);

  // A lock is on Stellar that this trade has not recorded: record it now.
  useEffect(() => {
    if (alreadyLocked) sync({ tradeId: trade.id });
  }, [alreadyLocked, sync, trade.id]);

  const amount = `${trimAmount(trade.amount)} ${trade.asset}`;
  const window = windowLabel(trade.windowSeconds);
  const problem = walletProblem(wallet, ready, trade.seller);
  // Reclaim after the window needs this key; the browser may not keep it that long.
  const backupProblem = exported ? null : lockBackupProblem(wallet);
  // A lock already sent from here must be recorded, never sent twice (round 2 F1).
  const sent = unrecordedLock(step.unreported, readPendingTx(trade.id));
  const blocked = sent
    ? sent
    : preflight.isLoading
      ? "Checking both wallets on Stellar testnet…"
      : preflight.error
        ? preflight.error.message
        : alreadyLocked
          ? (alreadyLocked.detail ?? alreadyLocked.label)
          : preflight.data?.blockedReason
            ? "Sort out the item above, then lock."
            : !ack
              ? "Tick the box above to continue."
              : (problem ?? backupProblem);

  return (
    <section className="space-y-10" aria-labelledby="lock-heading">
      <div className="space-y-5">
        <p className="eyebrow">Before you lock</p>
        <h2 id="lock-heading" className="text-3xl font-semibold tracking-tight">
          Lock <span className="font-mono font-medium [overflow-wrap:anywhere]">{amount}</span> for the buyer.
        </h2>
        <p className="border-l-2 border-ink pl-5 text-lg leading-relaxed text-ink">
          Once you lock, the buyer can claim the {amount} at any moment in the next {window}, whether or not they have
          handed you the cash. Lock only when you are both at the meeting point.
        </p>
      </div>

      <div className="space-y-3">
        <p className="eyebrow">Who can take the locked {trade.asset}</p>
        <dl className="divide-y divide-line border-y border-line">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
            <dt className="font-medium">
              Buyer <span className="font-mono text-xs font-normal text-slate">{shortAddress(trade.buyer)}</span>
            </dt>
            <dd className="text-slate">can claim for the next {window}</dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
            <dt className="font-medium">You</dt>
            <dd className="text-slate">can take it back after {window}</dd>
          </div>
        </dl>
        <p className="text-sm text-ink">No one else. Pairy is not on the lock and can&apos;t move it.</p>
        <p className="text-sm leading-relaxed text-slate">
          Locking also sets aside <span className="font-mono">1 XLM</span> from your wallet as a network reserve (
          <span className="font-mono">0.5 XLM</span> for each of the two people on the lock). It comes back to you
          when the buyer claims or you take it back.
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
              <span className={c.ok ? "text-slate" : "font-medium text-ink"}>{checkText(c, trade.asset)}</span>
            </li>
          ))}
        </ul>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 text-sm leading-relaxed">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-ink"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        <span>
          I understand the buyer can claim the {amount} at any moment in the next {window}, even before I have the
          cash, and we are both at the meeting point now.
        </span>
      </label>

      <div className="space-y-3">
        <Button
          variant="beacon"
          size="lg"
          className="h-auto min-h-14 w-full whitespace-normal py-3 [overflow-wrap:anywhere]"
          disabled={!!blocked || step.busy}
          onClick={() =>
            wallet &&
            step.run(
              wallet,
              async () => {
                return buildLockTransaction(
                  await loadSourceAccount(wallet.publicKey),
                  {
                    asset: toAsset(trade.asset),
                    amount: trade.amount,
                    buyer: trade.buyer,
                    windowSeconds: trade.windowSeconds,
                  },
                  // On Horizon's clock, so a slow device clock can't expire it.
                  await networkDeadline(300),
                );
              },
              {
                // The buyer may have cancelled, or another tab locked, while
                // the signing prompt was open (Q-3).
                beforeSubmit: async () => {
                  const [now, checks] = await Promise.all([
                    utils.trade.byId.fetch({ id: trade.id }, { staleTime: 0 }),
                    utils.trade.lockPreflight.fetch({ tradeId: trade.id }, { staleTime: 0 }),
                  ]);
                  const stop = lockGuard(now.state, checks.checks);
                  if (stop) {
                    void utils.trade.invalidate();
                    throw new Error(stop);
                  }
                },
              },
            )
          }
        >
          {step.busy ? "Signing and sending…" : `Lock ${amount}`}
        </Button>
        {blocked && blocked === problem ? (
          <WalletHint problem={problem} />
        ) : blocked && blocked === backupProblem ? (
          <div className="space-y-3">
            <p className="text-sm text-slate">{backupProblem}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                exportBackup()
                  .then(() => setExported(true))
                  .catch((e) => toast.error(e instanceof Error ? e.message : "Something went wrong."))
              }
            >
              <Download strokeWidth={1.5} />
              Export backup
            </Button>
          </div>
        ) : (
          blocked && <p className="text-sm text-slate">{blocked}</p>
        )}
        <StepFeedback step={step} />
      </div>
    </section>
  );
}
