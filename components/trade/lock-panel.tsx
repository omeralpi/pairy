'use client';

import { CheckCircle2, Circle, Lock } from "lucide-react";
import { useState } from "react";

import { shortAddress, trimAmount } from "@/components/listing/format";
import { btnPrimary, windowLabel, windowShort, type TradeView } from "@/components/trade/format";
import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { useChainStep } from "@/components/trade/use-chain-step";
import { api } from "@/lib/api";
import { toAsset } from "@/lib/stellar/assets";
import { buildLockTransaction } from "@/lib/stellar/settlement";
import { loadSourceAccount } from "@/lib/trade/sign-and-submit";
import { cn } from "@/lib/utils";
import { useWallet } from "@/lib/wallet/use-wallet";

/** The seller's lock screen (state agreed). */
export function LockPanel({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const { wallet, ready } = useWallet();
  const [ack, setAck] = useState(false);
  const preflight = api.trade.lockPreflight.useQuery({ tradeId: trade.id }, { refetchInterval: 15_000 });
  const recordLock = api.trade.recordLock.useMutation();
  const step = useChainStep(async (txHash) => {
    await recordLock.mutateAsync({ tradeId: trade.id, txHash });
    await utils.trade.invalidate();
  });

  const amount = `${trimAmount(trade.amount)} ${trade.asset}`;
  const window = windowLabel(trade.windowSeconds);
  const short = windowShort(trade.windowSeconds);
  const problem = walletProblem(wallet, ready, trade.seller);
  const blocked = preflight.isLoading
    ? "Checking both accounts on Stellar testnet…"
    : preflight.error
      ? preflight.error.message
      : (preflight.data?.blockedReason ??
        (!ack ? "Confirm the statement above to continue." : problem));

  return (
    <section className="space-y-4 rounded-2xl border-2 border-pairy-flame/50 bg-card p-5">
      <h2 className="flex items-center gap-2 font-display text-xl font-bold">
        <Lock className="size-5 text-pairy-flame" /> Lock {amount}
      </h2>

      <p className="rounded-xl bg-pairy-flame/10 p-4 text-base font-medium leading-relaxed">
        Once you lock, the buyer can claim these funds at any moment in the next {window}, whether or not they have
        handed you the cash. Lock only when you are both at the meeting point.
      </p>

      <div className="space-y-1 text-sm">
        <p className="font-semibold">Who can take the locked {trade.asset}</p>
        <p>
          Buyer ({shortAddress(trade.buyer)}): can claim before {short} · You: can reclaim after {short}
        </p>
        <p className="text-muted-foreground">
          No one else. Pairy is not a claimant and cannot move these funds. The lock also holds 1 XLM of reserve
          (0.5 XLM per claimant) from your account, which comes back to you on claim or reclaim.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">Before you lock</p>
          <button className="text-xs text-muted-foreground underline" onClick={() => preflight.refetch()}>
            {preflight.isFetching ? "Checking…" : "Check again"}
          </button>
        </div>
        <ul className="space-y-1.5">
          {preflight.data?.checks.map((c) => (
            <li key={c.id} className="flex gap-2 text-sm">
              {c.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-destructive" />
              )}
              <span className={cn(!c.ok && "text-destructive")}>{c.ok ? c.label : c.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-[#FF4E2B]"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        <span>
          I understand the buyer can claim the {amount} at any moment in the next {window}, even before I have the
          cash, and we are both at the meeting point now.
        </span>
      </label>

      <div className="space-y-2">
        <button
          className={cn(btnPrimary, "w-full")}
          disabled={!!blocked || step.busy}
          onClick={() =>
            wallet &&
            step.run(wallet, async () => {
              return buildLockTransaction(await loadSourceAccount(wallet.publicKey), {
                asset: toAsset(trade.asset),
                amount: trade.amount,
                buyer: trade.buyer,
                windowSeconds: trade.windowSeconds,
              });
            })
          }
        >
          {step.busy ? "Signing and submitting…" : `Lock ${amount}`}
        </button>
        {blocked && blocked === problem ? (
          <WalletHint problem={problem} />
        ) : (
          blocked && <p className="text-sm text-muted-foreground">{blocked}</p>
        )}
        <StepFeedback step={step} />
      </div>
    </section>
  );
}
