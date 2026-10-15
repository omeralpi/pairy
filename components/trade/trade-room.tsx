'use client';

import { ArrowLeft, ExternalLink, Flag, MapPin } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { ChatPanel } from "@/components/chat/chat-panel";
import { shortAddress, trimAmount } from "@/components/listing/format";
import {
  STATE_LABEL,
  STATE_STYLE,
  btnPrimary,
  btnSecondary,
  roleName,
  windowLabel,
  type TradeView,
} from "@/components/trade/format";
import { ClaimPanel, ReclaimPanel } from "@/components/trade/locked-panels";
import { LockPanel } from "@/components/trade/lock-panel";
import { Timeline } from "@/components/trade/timeline";
import { TrustlineButton } from "@/components/trade/trustline-button";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { isTerminal } from "@/lib/trade/state-machine";
import { cn } from "@/lib/utils";

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
    <button
      className={btnSecondary}
      disabled={cancel.isPending}
      onClick={() => confirm("Cancel this trade? Its chat will be deleted.") && cancel.mutate({ tradeId: trade.id })}
    >
      Cancel trade
    </button>
  );

  switch (trade.state) {
    case "listed":
      return (
        <section className="space-y-3 rounded-2xl border bg-card p-5">
          {trade.role === trade.openedBy ? (
            <p className="text-sm">Waiting for the {other} to agree to these terms. Nothing is locked yet.</p>
          ) : (
            <>
              <p className="text-sm">
                The {other} wants to trade on your listing at these terms. Agreeing moves no funds: the seller locks
                only when you meet.
              </p>
              <button className={btnPrimary} disabled={agree.isPending} onClick={() => agree.mutate({ tradeId: trade.id })}>
                Agree to trade
              </button>
            </>
          )}
          {buyerNeedsTrustline && <TrustlineButton buyer={trade.buyer} onDone={() => utils.trade.invalidate()} />}
          {cancelButton}
        </section>
      );
    case "agreed":
      return trade.role === "seller" ? (
        <>
          <LockPanel trade={trade} />
          {cancelButton}
        </>
      ) : (
        <section className="space-y-3 rounded-2xl border bg-card p-5">
          <p className="text-sm leading-relaxed">
            Meet at the agreed point. The seller locks the {trade.asset} there, and this page shows it as{" "}
            <strong>Locked</strong>. Hand over the cash only after that, then claim.
          </p>
          {buyerNeedsTrustline && <TrustlineButton buyer={trade.buyer} onDone={() => utils.trade.invalidate()} />}
          {cancelButton}
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
      <p className="inline-flex items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
        <Flag className="size-4" /> A problem was flagged on this trade.
      </p>
    );
  }
  if (isTerminal(trade.state)) return null;
  return (
    <button
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground underline"
      disabled={flag.isPending}
      onClick={() =>
        confirm(
          "Flag a problem? This only records a flag on the trade. It does not freeze or move the funds: only the buyer can claim before the window closes and only the seller can reclaim after.",
        ) && flag.mutate({ tradeId: trade.id })
      }
    >
      <Flag className="size-3.5" /> Flag a problem
    </button>
  );
}

export function TradeRoom({ id }: { id: string }) {
  const { publicKey, loading } = useSession();
  const { data: trade, isLoading, error } = api.trade.byId.useQuery(
    { id },
    { enabled: !!publicKey, refetchInterval: 5000, retry: false },
  );

  if (loading || (publicKey && isLoading)) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (!publicKey) {
    return (
      <p className="p-6 text-sm">
        <Link href="/onboard" className="font-semibold text-pairy-flame underline">
          Sign in
        </Link>{" "}
        to see this trade.
      </p>
    );
  }
  if (error || !trade) return <p className="p-6 text-sm">{error?.message ?? "Trade not found"}</p>;

  const terminal = isTerminal(trade.state);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:py-10">
      <Link href="/trades" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> My trades
      </Link>

      <div className="mt-4 grid gap-6 md:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <article className="rounded-2xl border bg-card p-5 md:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", STATE_STYLE[trade.state])}>
                {STATE_LABEL[trade.state]}
              </span>
              <span className="text-xs text-muted-foreground">You are the {trade.role}</span>
            </div>
            <h1 className="mt-3 font-display text-3xl font-bold tracking-tight">
              {trimAmount(trade.amount)} {trade.asset}
            </h1>
            <p className="mt-1 text-muted-foreground">
              for {trimAmount(trade.fiatAmount)} {trade.fiatCode} in cash
            </p>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">{roleName(trade.role === "seller" ? "buyer" : "seller")}</dt>
                <dd>
                  <a
                    href={trade.counterpartyUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={trade.counterparty}
                    className="inline-flex items-center gap-1 font-mono underline decoration-dotted underline-offset-4"
                  >
                    {shortAddress(trade.counterparty)} <ExternalLink className="size-3" />
                  </a>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">City</dt>
                <dd className="inline-flex items-center gap-1">
                  <MapPin className="size-3.5" /> {trade.cityName}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="text-muted-foreground">Claim window</dt>
                <dd>
                  {windowLabel(trade.windowSeconds)} from the lock: buyer claims inside it, seller reclaims after it
                </dd>
              </div>
            </dl>
            <div className="mt-4">
              <DisputeFlag trade={trade} />
            </div>
          </article>

          <Actions trade={trade} />

          <section className="rounded-2xl border bg-card p-5">
            <h2 className="mb-3 font-semibold">Timeline</h2>
            <Timeline trade={trade} />
          </section>
        </div>

        <ChatPanel tradeId={trade.id} me={publicKey} closed={terminal} />
      </div>
    </div>
  );
}
