'use client';

import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { amountRange, countryName, rateLabel, shortAddress } from "@/components/listing/format";
import { StartTradeButton } from "@/components/trade/start-trade-button";
import { api } from "@/lib/api";

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-3.5">
      <dt className="eyebrow">{label}</dt>
      <dd className="text-right font-mono text-sm tabular-nums text-ink">{children}</dd>
    </div>
  );
}

export default function ListingPage({ params }: { params: { id: string } }) {
  const { data: listing, isLoading, error } = api.listing.byId.useQuery({ id: params.id }, { retry: false });

  return (
    <div className="mx-auto max-w-xl px-4 py-6 md:py-12">
      <Link href="/map" className="inline-flex items-center gap-1.5 text-sm text-slate transition-colors hover:text-ink">
        <ArrowLeft className="size-4" strokeWidth={1.5} /> Map
      </Link>

      {isLoading ? (
        <p className="mt-8 text-sm text-slate">Loading…</p>
      ) : error || !listing ? (
        <p className="mt-8 text-sm text-ink">This listing does not exist.</p>
      ) : (
        <article className="mt-8 space-y-10">
          <header>
            <p className="eyebrow">
              {listing.cityName} · Listing{listing.status !== "active" && ` · ${listing.status}`}
            </p>
            <h1 className="mt-3 text-4xl font-bold leading-tight tracking-tight text-ink md:text-5xl">
              {listing.side === "sell_crypto" ? "Selling" : "Buying"}{" "}
              <span className="font-mono font-medium tracking-normal">{amountRange(listing)}</span>{" "}
              {listing.side === "sell_crypto" ? "for" : "with"}{" "}
              <em className="font-serif font-normal">cash.</em>
            </h1>
            <p className="mt-3 text-slate">
              At <span className="font-mono text-ink">{rateLabel(listing)}</span>, met in person in {listing.cityName}.
            </p>
          </header>

          <dl className="divide-y divide-line border-y border-line">
            <Term label="Rate">{rateLabel(listing)}</Term>
            <Term label="Amount">{amountRange(listing)}</Term>
            <Term label="Asset">{listing.asset} · testnet</Term>
            <Term label="City">
              <span className="font-sans text-base">
                {listing.cityName}, {countryName(listing.countryCode)}
              </span>
            </Term>
            <Term label="Posted by">
              <a
                href={`https://stellar.expert/explorer/testnet/account/${listing.owner}`}
                target="_blank"
                rel="noreferrer"
                title={listing.owner}
                className="underline decoration-ink/30 underline-offset-4 hover:decoration-ink"
              >
                {shortAddress(listing.owner)}
              </a>
            </Term>
          </dl>

          {listing.note && (
            <div className="rounded-xl bg-sand p-5">
              <p className="eyebrow">Their note</p>
              <p className="mt-2 whitespace-pre-wrap text-ink">{listing.note}</p>
            </div>
          )}

          <div className="space-y-4">
            <StartTradeButton listingId={listing.id} />
            <p className="text-sm text-slate">
              The pin shows the city, not the person. Agree the meeting point in the chat.
            </p>
          </div>
        </article>
      )}
    </div>
  );
}
