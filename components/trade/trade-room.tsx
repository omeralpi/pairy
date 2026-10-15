'use client';

import { ArrowLeft, Flag } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { ChatPanel } from "@/components/chat/chat-panel";
import { shortAddress, trimAmount } from "@/components/listing/format";
import {
  rateOf,
  roleName,
  statusSentence,
  windowLabel,
  windowShort,
  type TradeView,
} from "@/components/trade/format";
import { ClaimPanel, ReclaimPanel } from "@/components/trade/locked-panels";
import { LockPanel } from "@/components/trade/lock-panel";
import { Timeline } from "@/components/trade/timeline";
import { TrustlineButton } from "@/components/trade/trustline-button";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { HORIZON_URL, explorerTxUrl } from "@/lib/stellar/horizon";
import { isTerminal } from "@/lib/trade/state-machine";

const linkClass = "text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";

function useMutationOpts() {
  const utils = api.useUtils();
  return { onSuccess: () => utils.trade.invalidate(), onError: (e: { message: string }) => toast.error(e.message) };
}

/** What the viewer can do now, by role and state. */
function Actions({ trade }: { trade: TradeView }) {
  const utils = api.useUtils();
  const opts = useMutationOpts();
  const agree = api.trade.agree.useMutation(opts);
  const cancel = api.trade.cancel.useMutation(opts);
  const buyerPreflight = api.trade.lockPreflight.useQuery(
    { tradeId: trade.id },
    { enabled: trade.role === "buyer" && trade.asset === "USDC" && trade.state !== "locked" },
  );
  const buyerNeedsTrustline = buyerPreflight.data?.checks.some((c) => c.id === "buyerTrustline" && !c.ok);
  const other = roleName(trade.role === "seller" ? "buyer" : "seller").toLowerCase();

  const cancelButton = (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-4 text-slate hover:text-ink"
      disabled={cancel.isPending}
      onClick={() => confirm("Cancel this trade? Its chat will be deleted.") && cancel.mutate({ tradeId: trade.id })}
    >
      Cancel trade
    </Button>
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
            Meet at the agreed point. The seller locks the {trade.asset} there, and this page changes to &ldquo;It&apos;s
            locked for you.&rdquo; Hand over the cash only after that, then claim.
          </p>
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
    <button
      className="inline-flex items-center gap-1.5 text-xs text-slate underline decoration-slate/40 underline-offset-4 hover:text-ink"
      disabled={flag.isPending}
      onClick={() =>
        confirm(
          `Flag a problem? This only adds a note to the trade. It doesn't freeze or move the ${trade.asset}: only the buyer can claim in the first ${span} after the lock, and only the seller can take it back after that.`,
        ) && flag.mutate({ tradeId: trade.id })
      }
    >
      <Flag className="size-3.5" strokeWidth={1.5} /> Flag a problem
    </button>
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

export function TradeRoom({ id }: { id: string }) {
  const { publicKey, loading } = useSession();
  const { data: trade, isLoading, error } = api.trade.byId.useQuery(
    { id },
    { enabled: !!publicKey, refetchInterval: 5000, retry: false },
  );

  if (loading || (publicKey && isLoading)) return <p className="p-6 text-sm text-slate">Loading…</p>;
  if (!publicKey) {
    return (
      <p className="p-6 text-sm">
        <Link href="/onboard" className={`font-medium ${linkClass}`}>
          Sign in
        </Link>{" "}
        to see this trade.
      </p>
    );
  }
  if (error || !trade) return <p className="p-6 text-sm">{error?.message ?? "Trade not found."}</p>;

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
              <em className="font-serif font-normal">
                {amount} {trade.asset}
              </em>{" "}
              for {fiat} {trade.fiatCode}.
            </h1>
            <p className="text-xl leading-snug text-ink">{statusSentence(trade)}</p>
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
            <p className="text-base text-ink">
              → {amount} {trade.asset}
            </p>
            <p className="text-slate">
              · rate 1 {trade.asset} = {rateOf(trade.amount, trade.fiatAmount)} {trade.fiatCode}
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
