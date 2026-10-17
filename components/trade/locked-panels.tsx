'use client';

import { useEffect } from "react";

import { shortAddress, trimAmount } from "@/components/listing/format";
import { countdown, shortWhen, windowLabel, type TradeView } from "@/components/trade/format";
import { CLAIM_MARGIN_MS, claimClosesAt, claimTrustlineProblem, serverClock, windowGates } from "@/components/trade/guards";
import { StepFeedback, WalletHint, walletProblem } from "@/components/trade/step-feedback";
import { TrustlineButton } from "@/components/trade/trustline-button";
import { useChainStep } from "@/components/trade/use-chain-step";
import { useNow } from "@/components/trade/use-now";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { buildClaimTransaction } from "@/lib/stellar/settlement";
import { loadSourceAccount } from "@/lib/trade/sign-and-submit";
import { useWallet } from "@/lib/wallet/use-wallet";

/**
 * Countdown data plus the current time on the server's clock, ticking every
 * second; polled faster in the last minute so buttons flip on time (Q-17).
 */
function useClaimWindow(trade: TradeView, edge: "buyerClaimUntil" | "sellerReclaimFrom") {
  const deviceNow = useNow();
  const window = api.trade.claimWindow.useQuery(
    { tradeId: trade.id },
    {
      refetchInterval: (q) => {
        const d = q.state.data;
        const at = d?.[edge];
        return d && at && Math.abs(at - serverClock(Date.now(), d.serverNow, q.state.dataUpdatedAt)) < 60_000
          ? 5_000
          : 30_000;
      },
    },
  );
  const w = window.data;
  const now = w ? serverClock(deviceNow, w.serverNow, window.dataUpdatedAt) : deviceNow;
  return { window, w, now };
}

const TOO_LATE = `Claiming closes ${CLAIM_MARGIN_MS / 1000} seconds before the deadline, so a claim never reaches the network after it and fails. Only the seller can take it back once the deadline passes.`;

function useClaimStep(
  trade: TradeView,
  account: string,
  opts: {
    /** Runs before building; throw to stop. */
    check?: () => Promise<void>;
    /** The claim cutoff and the server's time now, both epoch ms; null when not known. */
    cutoff?: () => { closesAt: number; serverNow: number } | null;
    /** The server's time now, epoch ms, for a reclaim's 300 s validity; undefined when not known. */
    serverNow?: () => number | undefined;
  } = {},
) {
  const utils = api.useUtils();
  const { wallet, ready } = useWallet();
  const recordClaim = api.trade.recordClaim.useMutation();
  const step = useChainStep(
    async (txHash) => {
      try {
        await recordClaim.mutateAsync({ tradeId: trade.id, txHash });
      } catch (e) {
        // The background sync may have recorded this very claim first.
        const now = await utils.trade.byId.fetch({ id: trade.id }, { staleTime: 0 });
        if (now.claimTx !== txHash && now.reclaimTx !== txHash) throw e;
      }
      await utils.trade.invalidate();
    },
    { tradeId: trade.id, kind: "claim" },
  );
  const problem = walletProblem(wallet, ready, account);
  const verb = account === trade.buyer ? "Claim" : "Take back";
  const from = account === trade.buyer ? trade.seller : trade.buyer;
  const run = () =>
    wallet &&
    trade.balanceId &&
    step.run(
      wallet,
      async () => {
        await opts.check?.();
        // The network itself refuses the claim after the cutoff (tx_too_late,
        // no fee), whatever this device's clock says (F2).
        const c = opts.cutoff?.();
        const at = opts.serverNow?.();
        // Both on the server's clock, so a device clock minutes off can't
        // expire the transaction before it is sent.
        const notAfter = c
          ? Math.floor(c.closesAt / 1000)
          : at !== undefined
            ? Math.floor(at / 1000) + 300
            : undefined;
        return buildClaimTransaction(await loadSourceAccount(wallet.publicKey), trade.balanceId!, notAfter);
      },
      {
        // Written from the trade record, not decoded from the transaction: the
        // claim operation carries only the balance id (trade.balanceId).
        summary: `${verb} ${trimAmount(trade.amount)} ${trade.asset} from the lock shared with ${shortAddress(from)}`,
        // The signing prompt may have stayed open past the cutoff.
        beforeSubmit: () => {
          const c = opts.cutoff?.();
          if (c && c.serverNow >= c.closesAt) throw new Error(TOO_LATE);
        },
      },
    );
  return { step, problem, run };
}

/** Buyer, locked: claim once the cash has changed hands. */
export function ClaimPanel({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const { window, w, now } = useClaimWindow(trade, "buyerClaimUntil");
  const preflight = api.trade.lockPreflight.useQuery(
    { tradeId: trade.id },
    { enabled: trade.asset === "USDC", refetchInterval: 30_000 },
  );
  const trust = preflight.data ? claimTrustlineProblem(preflight.data.checks, trade.asset) : null;
  // Re-read the trustline right before signing: it can be removed, or its
  // limit lowered, after the lock (N-3).
  const { step, problem, run } = useClaimStep(trade, trade.buyer, {
    check: async () => {
      if (trade.asset !== "USDC") return;
      const fresh = await utils.trade.lockPreflight.fetch({ tradeId: trade.id }, { staleTime: 0 });
      const p = claimTrustlineProblem(fresh.checks, trade.asset);
      if (p) {
        void preflight.refetch();
        throw new Error(p.message);
      }
    },
    cutoff: () =>
      w?.buyerClaimUntil
        ? {
            closesAt: claimClosesAt(w.buyerClaimUntil),
            serverNow: serverClock(Date.now(), w.serverNow, window.dataUpdatedAt),
          }
        : null,
  });
  const amount = `${trimAmount(trade.amount)} ${trade.asset}`;
  const gates = w ? windowGates(w, now) : null;

  const blocked = window.error
    ? window.error.message
    : !w
      ? "Reading the lock from Stellar testnet…"
      : !w.buyerCanClaim || (w.buyerClaimUntil !== null && now >= w.buyerClaimUntil)
        ? `Your ${windowLabel(trade.windowSeconds)} to claim are up. Only the seller can take it back now.`
        : gates?.claimTooLate
          ? TOO_LATE
          : trust
            ? trust.message
            : problem;

  return (
    <section className="space-y-6" aria-labelledby="claim-heading">
      <div className="space-y-3">
        <p className="eyebrow">Your move</p>
        <h2 id="claim-heading" className="text-3xl font-semibold tracking-tight">
          Claim <span className="font-mono font-medium [overflow-wrap:anywhere]">{amount}</span> once the seller has the
          cash.
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
          . After that the seller can take it back, even if you paid.
        </p>
      )}
      {trust?.code === "op_no_trust" && <TrustlineButton buyer={trade.buyer} locked onDone={() => preflight.refetch()} />}
      <div className="space-y-3">
        <Button
          variant="beacon"
          size="lg"
          className="h-auto min-h-14 w-full whitespace-normal py-3 [overflow-wrap:anywhere]"
          disabled={!!blocked || !w || step.busy}
          onClick={run}
        >
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
  const { window, w, now } = useClaimWindow(trade, "sellerReclaimFrom");
  const { step, problem, run } = useClaimStep(trade, trade.seller, {
    serverNow: () => (w ? serverClock(Date.now(), w.serverNow, window.dataUpdatedAt) : undefined),
  });
  const reclaimOpen = !!w && windowGates(w, now).reclaimOpen;
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
      : !reclaimOpen
        ? `You can take it back once the buyer's ${span} are up.`
        : problem;

  return (
    <section className="space-y-6" aria-labelledby="reclaim-heading">
      <p id="reclaim-heading" className="leading-relaxed text-slate">
        The buyer can claim the{" "}
        <span className="font-mono text-ink">
          {trimAmount(trade.amount)} {trade.asset}
        </span>{" "}
        at any moment, cash or not. If they never claim, you can take it back after {span}.
      </p>
      {opensAt && (
        <div className="border-y border-line py-8">
          {reclaimOpen ? (
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
