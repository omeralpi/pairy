'use client';

import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { signerProblem, validity } from "@/components/arbiter/resolve-flow";
import { friendlyError } from "@/components/friendly-error";
import { shortAddress, trimAmount } from "@/components/listing/format";
import { shortWhen } from "@/components/trade/format";
import { useNow } from "@/components/trade/use-now";
import { api } from "@/lib/api";
import type { RouterOutputs } from "@/lib/api";
import { useWallet } from "@/lib/wallet/use-wallet";

type Row = RouterOutputs["arbiter"]["list"][number];

/** "Seller: yes · Buyer: no answer yet" */
export function answersLine(a: Row["answers"]): string {
  const said = (v: boolean | null) => (v === null ? "no answer yet" : v ? "yes" : "no");
  return `Seller: ${said(a.seller)} · Buyer: ${said(a.buyer)}`;
}

/** The open resolution's progress: "1 of 2 signed · valid until 14:05", or that it expired. */
export function resolutionLine(r: NonNullable<Row["resolution"]>, now: number): string {
  const v = validity(r.expiresAt, now);
  return `${r.signers.length} of ${r.threshold} signed · ${v.expired ? "expired; prepare again" : `valid until ${v.until}`}`;
}

/**
 * The open disputes (D2 §7.4), the earliest arbiter promise first, an overdue
 * one in red. No chat and no note: the list shows only what the rule needs.
 */
export function ArbiterList({ me, threshold }: { me: string; threshold: number }) {
  const now = useNow();
  const { wallet, ready } = useWallet();
  const { data, isLoading, error } = api.arbiter.list.useQuery(undefined, { refetchInterval: 15_000 });
  const problem = signerProblem(wallet, ready, me);
  const rows = [...(data ?? [])].sort((a, b) => a.promiseDeadline.getTime() - b.promiseDeadline.getTime());

  return (
    <div className="space-y-8">
      <p className="text-sm text-slate">
        Signed in as <span className="font-mono text-ink">{shortAddress(me)}</span>. A resolution needs {threshold} signatures; each
        signer signs on their own computer.
        {problem && problem !== "Loading your wallet…" && <> {problem}</>}
      </p>
      {isLoading ? (
        <p className="text-sm text-slate">Loading…</p>
      ) : error ? (
        <p className="text-sm text-danger" role="alert">
          {friendlyError(error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-lg text-slate">No open disputes.</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {rows.map((d) => (
            <li key={d.tradeId}>
              <Link href={`/arbiter/${d.tradeId}`} className="group flex items-center justify-between gap-4 py-5">
                <div className="min-w-0 space-y-1.5">
                  <p className="font-mono text-base text-ink">
                    {trimAmount(d.amount)} USDC{" "}
                    <span className="text-slate">
                      {shortAddress(d.seller)} → {shortAddress(d.buyer)}
                    </span>
                  </p>
                  <p className="text-sm text-ink">
                    {d.ready && d.outcome ? `Ready: all to the ${d.outcome} (rule ${d.rule})` : `Waiting for answers until ${shortWhen(d.answerDeadline)}`}
                  </p>
                  <p className="text-xs text-slate">
                    Dispute opened by the {d.disputeOpenedBy ?? "trader"}, {shortWhen(d.disputedAt!)} · {answersLine(d.answers)}
                  </p>
                  <p className={d.overdue ? "text-xs font-medium text-danger" : "text-xs text-slate"}>
                    {d.overdue ? `Overdue: promised by ${shortWhen(d.promiseDeadline)}` : `Resolve by ${shortWhen(d.promiseDeadline)}`}
                  </p>
                  {d.resolution && <p className="text-xs font-medium text-ink">{resolutionLine(d.resolution, now)}</p>}
                </div>
                <ChevronRight className="size-4 shrink-0 text-slate transition-colors group-hover:text-ink" strokeWidth={1.5} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
