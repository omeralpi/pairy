'use client';

import Link from "next/link";

import { shortAddress, trimAmount } from "@/components/listing/format";
import { STATE_LABEL, STATE_STYLE } from "@/components/trade/format";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import type { TradeState } from "@/lib/trade/state-machine";
import { cn } from "@/lib/utils";

// Live trades first, in the order they need attention.
const ORDER: TradeState[] = ["locked", "agreed", "listed", "claimed", "reclaimed", "cancelled"];

export default function TradesPage() {
  const { publicKey, loading } = useSession();
  const { data, isLoading, error } = api.trade.mine.useQuery(undefined, { enabled: !!publicKey, refetchInterval: 10_000 });

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 md:py-10">
      <h1 className="font-display text-2xl font-bold tracking-tight">My trades</h1>

      <div className="mt-6 space-y-8">
        {loading ? null : !publicKey ? (
          <p className="text-sm">
            <Link href="/onboard" className="font-semibold text-pairy-flame underline">
              Sign in
            </Link>{" "}
            to see your trades.
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No trades yet. Find a listing on the{" "}
            <Link href="/map" className="underline">
              map
            </Link>
            .
          </p>
        ) : (
          ORDER.map((state) => {
            const rows = data?.filter((t) => t.state === state) ?? [];
            if (rows.length === 0) return null;
            return (
              <section key={state}>
                <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{STATE_LABEL[state]}</h2>
                <ul className="space-y-2">
                  {rows.map((t) => (
                    <li key={t.id}>
                      <Link href={`/trades/${t.id}`} className="block rounded-xl border bg-card p-4 transition-colors hover:border-foreground">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold">
                              {t.role === "seller" ? "Selling" : "Buying"} {trimAmount(t.amount)} {t.asset}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {trimAmount(t.fiatAmount)} {t.fiatCode} · {t.cityName} · with{" "}
                              <span className="font-mono">{shortAddress(t.counterparty)}</span>
                            </p>
                          </div>
                          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold capitalize", STATE_STYLE[t.state])}>
                            {t.state}
                          </span>
                        </div>
                        {t.disputed && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Problem flagged</p>}
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
