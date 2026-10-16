'use client';

import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { shortAddress, trimAmount } from "@/components/listing/format";
import { STATE_LABEL, statusSentence } from "@/components/trade/format";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import type { TradeState } from "@/lib/trade/state-machine";

// Live trades first, in the order they need attention.
const ORDER: TradeState[] = ["locked", "agreed", "listed", "claimed", "reclaimed", "cancelled"];

const linkClass = "font-medium text-ink underline decoration-ink/30 underline-offset-4 hover:decoration-ink";

export default function TradesPage() {
  const { publicKey, loading } = useSession();
  const { data, isLoading, error } = api.trade.mine.useQuery(undefined, { enabled: !!publicKey, refetchInterval: 10_000 });

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:py-16">
      <p className="eyebrow">Your trades</p>
      <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">
        Your <em className="font-serif font-normal">trades.</em>
      </h1>

      <div className="mt-12 space-y-12">
        {loading ? null : !publicKey ? (
          <p className="text-slate">
            <Link href="/onboard" className={linkClass}>
              Sign in
            </Link>{" "}
            to see your trades.
          </p>
        ) : isLoading ? (
          <p className="text-sm text-slate">Loading…</p>
        ) : error ? (
          <p className="text-sm text-danger">{error.message}</p>
        ) : data?.length === 0 ? (
          <p className="text-lg text-slate">
            No trades yet.{" "}
            <Link href="/map" className={linkClass}>
              Find a peer on the map.
            </Link>
          </p>
        ) : (
          ORDER.map((state) => {
            const rows = data?.filter((t) => t.state === state) ?? [];
            if (rows.length === 0) return null;
            return (
              <section key={state} className="space-y-3">
                <h2 className="eyebrow">{STATE_LABEL[state]}</h2>
                <ul className="divide-y divide-line border-y border-line">
                  {rows.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={`/trades/${t.id}`}
                        className="group flex items-center justify-between gap-4 py-5"
                      >
                        <div className="min-w-0 space-y-1.5">
                          <p className="font-mono text-base text-ink">
                            {trimAmount(t.amount)} {t.asset}{" "}
                            <span className="text-slate">
                              → {trimAmount(t.fiatAmount)} {t.fiatCode}
                            </span>
                          </p>
                          <p className="text-sm text-ink">{statusSentence(t)}</p>
                          <p className="text-xs text-slate">
                            {t.role === "seller" ? "Selling" : "Buying"} · with{" "}
                            <span className="font-mono">{shortAddress(t.counterparty)}</span> · {t.cityName}
                          </p>
                          {t.disputed && <p className="text-xs font-medium text-warning">A problem was flagged.</p>}
                        </div>
                        <ChevronRight
                          className="size-4 shrink-0 text-slate transition-colors group-hover:text-ink"
                          strokeWidth={1.5}
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
