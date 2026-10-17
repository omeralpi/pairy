'use client';

import { ArrowLeft, Flag } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { toast } from "sonner";

import { ChatPanel } from "@/components/chat/chat-panel";
import { ConfirmAction } from "@/components/confirm-action";
import { friendlyError, isUnauthorized } from "@/components/friendly-error";
import { shortAddress, trimAmount } from "@/components/listing/format";
import {
  roleName,
  statusSentence,
  windowLabel,
  windowShort,
  type TradeView,
} from "@/components/trade/format";
import { buyerClaim, claimClosesAt, claimTrustlineProblem, serverClock } from "@/components/trade/guards";
import { ClaimPanel, ReclaimPanel } from "@/components/trade/locked-panels";
import { LockPanel } from "@/components/trade/lock-panel";
import { walletProblem } from "@/components/trade/step-feedback";
import { Timeline } from "@/components/trade/timeline";
import { TrustlineButton } from "@/components/trade/trustline-button";
import { useNow } from "@/components/trade/use-now";
import { useTradeSync } from "@/components/trade/use-trade-sync";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { HORIZON_URL, explorerTxUrl } from "@/lib/stellar/horizon";
import { isTerminal } from "@/lib/trade/state-machine";
import { useWallet } from "@/lib/wallet/use-wallet";

const linkClass = "text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function useMutationOpts() {
  const utils = api.useUtils();
  return {
    onSuccess: () => utils.trade.invalidate(),
    onError: (e: { message: string; data?: { code?: string } | null }) => {
      toast.error(friendlyError(e));
      // A lapsed session: let the page fall back to its sign-in prompt.
      if (isUnauthorized(e)) void utils.auth.me.invalidate();
      // The trade may have moved on in another tab; show where it stands now.
      else void utils.trade.invalidate();
    },
  };
}

/** What the viewer can do now, by role and state. */
function Actions({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const opts = useMutationOpts();
  const agree = api.trade.agree.useMutation(opts);
  const cancel = api.trade.cancel.useMutation(opts);
  const buyerPreflight = api.trade.lockPreflight.useQuery(
    { tradeId: trade.id },
    { enabled: trade.role === "buyer" && (trade.state === "listed" || trade.state === "agreed"), refetchInterval: 30_000 },
  );
  const buyerNeedsTrustline = buyerPreflight.data?.checks.some((c) => c.id === "buyerTrustline" && !c.ok);
  const buyerHasNoAccount = buyerPreflight.data?.checks.some((c) => c.id === "buyerAccount" && !c.ok);
  const other = roleName(trade.role === "seller" ? "buyer" : "seller").toLowerCase();

  const cancelButton = (
    <ConfirmAction
      title="Cancel this trade?"
      description="Its chat will be deleted. Nothing has been locked, so no money moves."
      confirmLabel="Cancel trade"
      onConfirm={() => cancel.mutate({ tradeId: trade.id })}
    >
      <Button variant="ghost" size="sm" className="-ml-4 text-slate hover:text-ink" disabled={cancel.isPending}>
        Cancel trade
      </Button>
    </ConfirmAction>
  );

  const noAccountNote = buyerHasNoAccount && (
    <div className="space-y-2 rounded-xl bg-sand p-5 text-sm leading-relaxed text-ink">
      <p>
        Your account isn&apos;t on Stellar testnet yet, so the seller can&apos;t lock the {trade.asset} for you. Fund it
        first.
      </p>
      <Link href="/wallet" className={`font-medium ${linkClass}`}>
        Open wallet
      </Link>
    </div>
  );

  switch (trade.state) {
    case "listed":
      return (
        <section className="space-y-5">
          {trade.role === trade.openedBy ? (
            <p className="leading-relaxed text-slate">
              Nothing is locked yet. Use the chat to agree where to meet while the {other} looks at your terms.
            </p>
          ) : (
            <>
              <p className="leading-relaxed text-slate">
                The {other} wants to trade on your listing at these terms. Agreeing moves no money: the seller locks
                only when you meet.
              </p>
              <Button variant="beacon" disabled={agree.isPending} onClick={() => agree.mutate({ tradeId: trade.id })}>
                Agree to trade
              </Button>
            </>
          )}
          {trade.role === "buyer" && noAccountNote}
          {buyerNeedsTrustline && <TrustlineButton buyer={trade.buyer} onDone={() => utils.trade.invalidate()} />}
          <div>{cancelButton}</div>
        </section>
      );
    case "agreed":
      return trade.role === "seller" ? (
        <div className="space-y-6">
          <LockPanel trade={trade} />
          {cancelButton}
        </div>
      ) : (
        <section className="space-y-5">
          <p className="leading-relaxed text-slate">
            Meet at the agreed point. The seller locks the {trade.asset} there, and this page on your own phone changes
            to &ldquo;It&apos;s locked for you.&rdquo; The seller&apos;s screen is not proof. Hand over the cash only
            after that, then claim before you part.
          </p>
          {noAccountNote}
          {buyerNeedsTrustline && <TrustlineButton buyer={trade.buyer} onDone={() => utils.trade.invalidate()} />}
          <div>{cancelButton}</div>
        </section>
      );
    case "locked":
      return trade.role === "buyer" ? <ClaimPanel trade={trade} /> : <ReclaimPanel trade={trade} />;
    default:
      return null;
  }
}

function DisputeFlag({ trade }: { trade: TradeView }) {
  const flag = api.trade.flagDispute.useMutation(useMutationOpts());
  if (trade.disputed) {
    return (
      <p className="inline-flex items-center gap-2 text-sm text-ink">
        <Flag className="size-4 text-slate" strokeWidth={1.5} /> A problem was flagged on this trade. That doesn&apos;t
        freeze or move the {trade.asset}.
      </p>
    );
  }
  if (isTerminal(trade.state)) return null;
  const span = windowLabel(trade.windowSeconds);
  return (
    <ConfirmAction
      title="Flag a problem?"
      description={`This only adds a note to the trade. It doesn't freeze or move the ${trade.asset}: only the buyer can claim in the first ${span} after the lock, and only the seller can take it back after that.`}
      confirmLabel="Flag it"
      onConfirm={() => flag.mutate({ tradeId: trade.id })}
    >
      <button
        className="inline-flex items-center gap-1.5 text-xs text-slate underline decoration-slate/40 underline-offset-4 hover:text-ink"
        disabled={flag.isPending}
      >
        <Flag className="size-3.5" strokeWidth={1.5} /> Flag a problem
      </button>
    </ConfirmAction>
  );
}

/** The technical record, collapsed. The only place jargon is allowed. */
function Proof({ trade }: { trade: TradeView }) {
  const secs = trade.windowSeconds;
  const receipts = [
    { label: "Lock", hash: trade.lockTx },
    { label: "Claim", hash: trade.claimTx },
    { label: "Reclaim", hash: trade.reclaimTx },
  ].filter((r): r is { label: string; hash: string } => !!r.hash);

  return (
    <details className="group border-t border-line pt-5">
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-ink [&::-webkit-details-marker]:hidden">
        How this is enforced
        <span className="font-mono text-slate group-open:hidden">+</span>
        <span className="hidden font-mono text-slate group-open:inline">−</span>
      </summary>
      <div className="mt-5 space-y-5 text-sm leading-relaxed text-slate">
        <p>
          The lock is a Stellar <span className="text-ink">claimable balance</span> (CAP-23) created from the
          seller&apos;s wallet, with exactly two claimants. Pairy holds no key, is not a claimant and cannot move it.
          Nothing here is a contract; the network checks the predicates on every claim.
        </p>
        <dl className="divide-y divide-line border-y border-line font-mono text-xs">
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
            <dt>buyer · {shortAddress(trade.buyer)}</dt>
            <dd className="text-ink">BEFORE_RELATIVE_TIME({secs})</dd>
          </div>
          <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2.5">
            <dt>seller · {shortAddress(trade.seller)}</dt>
            <dd className="text-ink">NOT(BEFORE_RELATIVE_TIME({secs}))</dd>
          </div>
        </dl>
        <p>
          {secs} seconds is {windowLabel(secs)}, counted from the moment the lock lands. The lock also holds 1 XLM of
          base reserve (0.5 XLM per claimant) against the seller, returned to the seller on claim or reclaim.
        </p>
        <p>
          To check it yourself, open the lock receipt on stellar.expert and find &ldquo;created claimable
          balance&rdquo;. It must be claimable by exactly two accounts: the buyer &ldquo;before{" "}
          {secs === 259_200 ? "3 days" : windowLabel(secs)} from now&rdquo; and the seller &ldquo;after&rdquo; that.
          If either says &ldquo;unconditional&rdquo;, the lock is broken.
        </p>
        {trade.balanceId && (
          <div className="space-y-1">
            <p className="eyebrow">Balance ID</p>
            <a
              href={`${HORIZON_URL}/claimable_balances/${trade.balanceId}`}
              target="_blank"
              rel="noreferrer"
              className={`block break-all font-mono text-xs ${linkClass}`}
            >
              {trade.balanceId} ↗
            </a>
          </div>
        )}
        {receipts.length > 0 && (
          <ul className="space-y-1 font-mono text-xs">
            {receipts.map((r) => (
              <li key={r.label}>
                {r.label} receipt ·{" "}
                <a href={explorerTxUrl(r.hash)} target="_blank" rel="noreferrer" className={linkClass}>
                  {r.hash.slice(0, 12)}… ↗
                </a>
              </li>
            ))}
          </ul>
        )}
        <p>
          Countdowns on this page are read from the balance with stellar-resolve-claimant-predicates. The network has
          the final say.
        </p>
      </div>
    </details>
  );
}

/**
 * The headline. On a locked trade it tells the buyer to hand over the cash
 * only when a claim would go through right now (Q-4, F5, round 2 F3).
 */
export function StatusLine({ trade }: { trade: TradeView }) {
  const now = useNow();
  const { wallet, ready } = useWallet();
  const locked = trade.state === "locked";
  const window = api.trade.claimWindow.useQuery({ tradeId: trade.id }, { enabled: locked, refetchInterval: 30_000 });
  // Same query as the claim screen's trustline re-check, so it is shared.
  const preflight = api.trade.lockPreflight.useQuery(
    { tradeId: trade.id },
    { enabled: locked && trade.role === "buyer" && trade.asset === "USDC", refetchInterval: 30_000 },
  );
  const w = locked && !window.error ? window.data : undefined;
  const serverNow = w ? serverClock(now, w.serverNow, window.dataUpdatedAt) : now;
  const closed = !!w && (!w.buyerCanClaim || (w.buyerClaimUntil !== null && serverNow >= w.buyerClaimUntil));
  const claim = buyerClaim({
    window: locked && !w ? "unknown" : closed ? "closed" : "open",
    tooLate: !!w?.buyerClaimUntil && serverNow >= claimClosesAt(w.buyerClaimUntil),
    trust: preflight.data ? (claimTrustlineProblem(preflight.data.checks, trade.asset)?.message ?? null) : null,
    wallet: trade.role === "buyer" ? walletProblem(wallet, ready, trade.buyer) : null,
  });
  // A live region, so "It's locked for you" reaches a screen reader when the
  // peer acts; it carries no countdown, so it only speaks when the state moves.
  return (
    <p role="status" className="text-xl leading-snug text-ink">
      {statusSentence(trade, claim)}
    </p>
  );
}

/** A paused or closed listing stops new trades only (Q-21). */
function ListingNote({ trade }: { trade: TradeView }) {
  const { data: listing } = api.listing.byId.useQuery({ id: trade.listingId }, { enabled: !isTerminal(trade.state) });
  if (!listing || listing.status === "active" || isTerminal(trade.state)) return null;
  return (
    <p className="text-sm text-slate">
      The listing is {listing.status}. That only stops new trades on it; this trade continues.
    </p>
  );
}

function Room({ trade, publicKey }: { trade: TradeView; publicKey: string }) {
  useTradeSync(trade);

  const terminal = isTerminal(trade.state);
  const amount = trimAmount(trade.amount);
  const fiat = trimAmount(trade.fiatAmount);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:py-14">
      <Link href="/trades" className="inline-flex items-center gap-1.5 text-sm text-slate hover:text-ink">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> My trades
      </Link>

      <div className="mt-8 grid gap-12 md:grid-cols-[1fr_22rem] lg:gap-16">
        <div className="min-w-0 space-y-12">
          <header className="space-y-5">
            <p className="eyebrow">
              You&apos;re the {trade.role} · {trade.cityName}
            </p>
            <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
              <em className="font-serif font-normal [overflow-wrap:anywhere]">
                {amount} {trade.asset}
              </em>{" "}
              for <span className="[overflow-wrap:anywhere]">{fiat}</span> {trade.fiatCode}.
            </h1>
            <StatusLine trade={trade} />
            <ListingNote trade={trade} />
            <p className="text-sm text-slate">
              Your peer, the {trade.role === "seller" ? "buyer" : "seller"}:{" "}
              <a
                href={trade.counterpartyUrl}
                target="_blank"
                rel="noreferrer"
                title={trade.counterparty}
                className={`font-mono ${linkClass}`}
              >
                {shortAddress(trade.counterparty)} ↗
              </a>
            </p>
            <DisputeFlag trade={trade} />
          </header>

          <div className="space-y-1.5 rounded-xl bg-sand p-6 font-mono text-sm">
            <p className="text-base text-ink [overflow-wrap:anywhere]">
              → {amount} {trade.asset}
            </p>
            <p className="text-slate">
              · rate 1 {trade.asset} = {trimAmount(trade.rate)} {trade.fiatCode}
            </p>
            <p className="text-slate">
              · cash {fiat} {trade.fiatCode}
            </p>
            <p className="text-slate">· window {windowShort(trade.windowSeconds)}</p>
            <p className="text-slate">· city {trade.cityName}</p>
            {trade.state === "claimed" && <p className="text-success">✓ settled in person</p>}
          </div>

          <Actions trade={trade} />

          <section className="space-y-3">
            <h2 className="eyebrow">What happened</h2>
            <Timeline trade={trade} />
          </section>

          <Proof trade={trade} />
        </div>

        <ChatPanel tradeId={trade.id} me={publicKey} closed={terminal} />
      </div>
    </div>
  );
}

export function TradeRoom({ id }: { id: string }) {
  const utils = api.useUtils();
  const { publicKey, loading } = useSession();
  // byId only takes a uuid; anything else is simply not a trade (Q-12).
  const valid = UUID.test(id);
  const { data: trade, isLoading, error } = api.trade.byId.useQuery(
    { id },
    { enabled: !!publicKey && valid, refetchInterval: 5000, retry: false },
  );
  const expired = isUnauthorized(error);
  useEffect(() => {
    if (expired) void utils.auth.me.invalidate();
  }, [expired, utils]);

  if (loading || (publicKey && valid && isLoading)) return <p className="p-6 text-sm text-slate">Loading…</p>;
  if (!publicKey || expired) {
    return (
      <p className="p-6 text-sm">
        {expired && "Your session ended. "}
        <Link href={`/onboard?next=${encodeURIComponent(`/trades/${id}`)}`} className={`font-medium ${linkClass}`}>
          Sign in
        </Link>{" "}
        to see this trade.
      </p>
    );
  }
  // A failed 5 s refresh keeps the trade it last read: swapping the room for
  // the error would close a pincode prompt the user is typing into.
  if (!valid || !trade) {
    return <p className="p-6 text-sm">{error && valid ? friendlyError(error) : "Trade not found."}</p>;
  }
  return <Room trade={trade} publicKey={publicKey} />;
}
