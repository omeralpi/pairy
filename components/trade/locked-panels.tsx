'use client';

import { useEffect } from "react";

import { trimAmount } from "@/components/listing/format";
import { countdown, shortWhen, windowLabel, type TradeView } from "@/components/trade/format";
import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { TrustlineButton } from "@/components/trade/trustline-button";
import { useChainStep } from "@/components/trade/use-chain-step";
import { useNow } from "@/components/trade/use-now";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { buildClaimTransaction } from "@/lib/stellar/settlement";
import { loadSourceAccount } from "@/lib/trade/sign-and-submit";
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
      ? `Your ${windowLabel(trade.windowSeconds)} to claim are up. Only the seller can take it back now.`
      : needsTrustline
        ? `Add ${trade.asset} to your wallet first.`
        : problem;

  return (
    <section className="space-y-6" aria-labelledby="claim-heading">
      <div className="space-y-3">
        <p className="eyebrow">Your move</p>
        <h2 id="claim-heading" className="text-3xl font-semibold tracking-tight">
          Claim <span className="font-mono font-medium">{amount}</span> once the seller has the cash.
        </h2>
        <p className="leading-relaxed text-slate">Only you can claim it, from your own device.</p>
      </div>
      {w?.buyerClaimUntil && (
        <p className="text-sm text-slate">
          You can claim until <span className="font-mono text-ink">{shortWhen(w.buyerClaimUntil)}</span>
          {w.buyerCanClaim && (
            <>
              {" "}
              · <span className="font-mono tabular-nums text-ink">{countdown(w.buyerClaimUntil - now)}</span> left
            </>
          )}
          .
        </p>
      )}
      {needsTrustline && <TrustlineButton buyer={trade.buyer} onDone={() => preflight.refetch()} />}
      <div className="space-y-3">
        <Button variant="beacon" size="lg" className="w-full" disabled={!!blocked || !w || step.busy} onClick={run}>
          {step.busy ? "Signing and sending…" : `Claim ${amount}`}
        </Button>
        {blocked === problem ? <WalletHint problem={problem} /> : <p className="text-sm text-slate">{blocked}</p>}
        <StepFeedback step={step} />
      </div>
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
  const span = windowLabel(trade.windowSeconds);

  // The package evaluated the predicate at fetch time; ask again once the
  // countdown reaches zero so the button unlocks without a reload.
  const crossed = opensAt !== null && now >= opensAt;
  useEffect(() => {
    if (crossed && !w?.sellerCanReclaim) void refetch();
  }, [crossed, w?.sellerCanReclaim, refetch]);

  const blocked = window.error
    ? window.error.message
    : !w
      ? "Reading the lock from Stellar testnet…"
      : !w.sellerCanReclaim
        ? `You can take it back once the buyer's ${span} are up.`
        : problem;

  return (
    <section className="space-y-6" aria-labelledby="reclaim-heading">
      <p id="reclaim-heading" className="leading-relaxed text-slate">
        The buyer can claim the{" "}
        <span className="font-mono text-ink">
          {trimAmount(trade.amount)} {trade.asset}
        </span>{" "}
        once they have handed you the cash. If they never claim, you can take it back after {span}.
      </p>
      {opensAt && (
        <div className="border-y border-line py-8">
          {w?.sellerCanReclaim ? (
            <p className="text-2xl font-semibold tracking-tight">You can take it back now.</p>
          ) : (
            <>
              <p className="eyebrow">You can take it back in</p>
              <p className="mt-2 font-mono text-5xl font-medium tabular-nums tracking-tight md:text-6xl">
                {countdown(opensAt - now)}
              </p>
              <p className="mt-2 font-mono text-xs text-slate">from {shortWhen(opensAt)}</p>
            </>
          )}
        </div>
      )}
      <div className="space-y-3">
        <Button size="lg" className="w-full" disabled={!!blocked || step.busy} onClick={run}>
          {step.busy ? "Signing and sending…" : "Take it back"}
        </Button>
        {blocked === problem ? <WalletHint problem={problem} /> : <p className="text-sm text-slate">{blocked}</p>}
        <StepFeedback step={step} />
      </div>
    </section>
  );
}
