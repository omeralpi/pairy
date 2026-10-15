'use client';

import { useEffect } from "react";

import { trimAmount } from "@/components/listing/format";
import { btnPrimary, countdown, type TradeView } from "@/components/trade/format";
import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { TrustlineButton } from "@/components/trade/trustline-button";
import { useChainStep } from "@/components/trade/use-chain-step";
import { useNow } from "@/components/trade/use-now";
import { api } from "@/lib/api";
import { buildClaimTransaction } from "@/lib/stellar/settlement";
import { loadSourceAccount } from "@/lib/trade/sign-and-submit";
import { cn } from "@/lib/utils";
import { useWallet } from "@/lib/wallet/use-wallet";

function useClaimStep(trade: TradeView, account: string) {
  const utils = api.useUtils();
  const { wallet, ready } = useWallet();
  const recordClaim = api.trade.recordClaim.useMutation();
  const step = useChainStep(async (txHash) => {
    await recordClaim.mutateAsync({ tradeId: trade.id, txHash });
    await utils.trade.invalidate();
  });
  const problem = walletProblem(wallet, ready, account);
  const run = () =>
    wallet &&
    trade.balanceId &&
    step.run(wallet, async () => buildClaimTransaction(await loadSourceAccount(wallet.publicKey), trade.balanceId!));
  return { step, problem, run };
}

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Buyer, locked: claim once the cash has changed hands. */
export function ClaimPanel({ trade }: { trade: TradeView }) {
  const now = useNow();
  const window = api.trade.claimWindow.useQuery({ tradeId: trade.id }, { refetchInterval: 30_000 });
  const preflight = api.trade.lockPreflight.useQuery({ tradeId: trade.id }, { enabled: trade.asset === "USDC" });
  const needsTrustline = preflight.data?.checks.some((c) => c.id === "buyerTrustline" && !c.ok) ?? false;
  const { step, problem, run } = useClaimStep(trade, trade.buyer);
  const amount = `${trimAmount(trade.amount)} ${trade.asset}`;
  const w = window.data;

  const blocked = window.error
    ? window.error.message
    : w && !w.buyerCanClaim
      ? "The claim window has closed. Only the seller can take the funds back now."
      : needsTrustline
        ? "Add the USDC trustline first."
        : problem;

  return (
    <section className="space-y-4 rounded-2xl border-2 border-emerald-500/50 bg-card p-5">
      <h2 className="font-display text-xl font-bold">{amount} is locked for you</h2>
      <p className="text-sm leading-relaxed">
        Hand over the cash, then claim. Only you can claim, from your own device, and only until the window closes.
      </p>
      {w?.buyerClaimUntil && (
        <p className="text-sm">
          You can claim until <strong>{when(w.buyerClaimUntil)}</strong>
          {w.buyerCanClaim && <> ({countdown(w.buyerClaimUntil - now)} left)</>}.
        </p>
      )}
      {needsTrustline && <TrustlineButton buyer={trade.buyer} onDone={() => preflight.refetch()} />}
      <button className={cn(btnPrimary, "w-full bg-emerald-600")} disabled={!!blocked || !w || step.busy} onClick={run}>
        {step.busy ? "Signing and submitting…" : `Claim ${amount}`}
      </button>
      {blocked === problem ? <WalletHint problem={problem} /> : <p className="text-sm text-muted-foreground">{blocked}</p>}
      <StepFeedback step={step} />
    </section>
  );
}

/** Seller, locked: wait out the window, then reclaim. */
export function ReclaimPanel({ trade }: { trade: TradeView }) {
  const now = useNow();
  const window = api.trade.claimWindow.useQuery({ tradeId: trade.id }, { refetchInterval: 30_000 });
  const { step, problem, run } = useClaimStep(trade, trade.seller);
  const w = window.data;
  const opensAt = w?.sellerReclaimFrom ?? null;
  const { refetch } = window;

  // The package evaluated the predicate at fetch time; ask again once the
  // countdown reaches zero so the button unlocks without a reload.
  const crossed = opensAt !== null && now >= opensAt;
  useEffect(() => {
    if (crossed && !w?.sellerCanReclaim) void refetch();
  }, [crossed, w?.sellerCanReclaim, refetch]);

  const blocked = window.error
    ? window.error.message
    : !w
      ? "Reading the locked balance from Stellar testnet…"
      : !w.sellerCanReclaim
        ? "Reclaim opens when the buyer's claim window closes."
        : problem;

  return (
    <section className="space-y-4 rounded-2xl border bg-card p-5">
      <h2 className="font-display text-xl font-bold">
        {trimAmount(trade.amount)} {trade.asset} is locked
      </h2>
      <p className="text-sm leading-relaxed">
        The buyer can claim it once they have handed you the cash. If they never claim, you can take it back after
        the window closes.
      </p>
      {opensAt && (
        <div className="rounded-xl bg-secondary p-4 text-center">
          {w?.sellerCanReclaim ? (
            <p className="font-semibold">You can reclaim now.</p>
          ) : (
            <>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Reclaim opens in</p>
              <p className="font-display text-2xl font-bold tabular-nums">{countdown(opensAt - now)}</p>
              <p className="text-xs text-muted-foreground">{when(opensAt)}</p>
            </>
          )}
        </div>
      )}
      <button className={cn(btnPrimary, "w-full")} disabled={!!blocked || step.busy} onClick={run}>
        {step.busy ? "Signing and submitting…" : "Reclaim"}
      </button>
      {blocked === problem ? <WalletHint problem={problem} /> : <p className="text-sm text-muted-foreground">{blocked}</p>}
      <StepFeedback step={step} />
    </section>
  );
}
