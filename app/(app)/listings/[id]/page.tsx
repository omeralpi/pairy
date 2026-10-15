'use client';

import { ArrowLeft, MapPin } from "lucide-react";
import Link from "next/link";

import { amountRange, countryName, rateLabel, shortAddress } from "@/components/listing/format";
import { SideBadge } from "@/components/listing/listing-card";
import { StartTradeButton } from "@/components/trade/start-trade-button";
import { api } from "@/lib/api";

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums">{children}</dd>
    </div>
  );
}

export default function ListingPage({ params }: { params: { id: string } }) {
  const { data: listing, isLoading, error } = api.listing.byId.useQuery({ id: params.id }, { retry: false });

  return (
    <div className="mx-auto max-w-lg px-4 py-6 md:py-10">
      <Link href="/map" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Map
      </Link>

      {isLoading ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
      ) : error || !listing ? (
        <p className="mt-6 text-sm">This listing does not exist.</p>
      ) : (
        <article className="mt-4 rounded-2xl border bg-card p-5 md:p-6">
          <div className="flex items-center gap-2">
            <SideBadge side={listing.side} />
            {listing.status !== "active" && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold capitalize text-muted-foreground">
                {listing.status}
              </span>
            )}
          </div>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight">{amountRange(listing)}</h1>
          <p className="mt-1 text-muted-foreground">
            {listing.side === "sell_crypto" ? "for cash" : "paid in cash"} at {rateLabel(listing)}
          </p>

          <dl className="mt-5 divide-y border-y">
            <Term label="Asset">{listing.asset} (Stellar testnet)</Term>
            <Term label="Amount">{amountRange(listing)}</Term>
            <Term label="Rate">{rateLabel(listing)}</Term>
            <Term label="City">
              <span className="inline-flex items-center gap-1">
                <MapPin className="size-3.5" />
                {listing.cityName}, {countryName(listing.countryCode)}
              </span>
            </Term>
            <Term label="Posted by">
              <a
                href={`https://stellar.expert/explorer/testnet/account/${listing.owner}`}
                target="_blank"
                rel="noreferrer"
                title={listing.owner}
                className="font-mono text-sm underline decoration-dotted underline-offset-4"
              >
                {shortAddress(listing.owner)}
              </a>
            </Term>
          </dl>

          {listing.note && <p className="mt-4 whitespace-pre-wrap rounded-xl bg-secondary p-3 text-sm">{listing.note}</p>}

          <p className="mt-4 text-xs text-muted-foreground">
            The pin marks the city, not a person. You agree the meeting point in the trade chat.
          </p>

          <div className="mt-5">
            <StartTradeButton listingId={listing.id} />
          </div>
        </article>
      )}
    </div>
  );
}
