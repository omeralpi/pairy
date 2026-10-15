import Link from "next/link";

import { amountRange, rateLabel, sideLabel, type Listing } from "./format";

/** One listing as a plain row. Put rows in a `divide-y divide-line` list. */
export function ListingCard({ listing, showCity = true }: { listing: Listing; showCity?: boolean }) {
  return (
    <Link
      href={`/listings/${listing.id}`}
      className="group flex items-baseline justify-between gap-4 py-4 transition-colors"
    >
      <div className="min-w-0">
        <p className="truncate font-medium text-ink underline-offset-4 group-hover:underline">
          {sideLabel(listing.side)} {amountRange(listing)}
        </p>
        {showCity && (
          <p className="mt-0.5 truncate text-sm text-slate">
            {listing.cityName}, {listing.countryCode}
          </p>
        )}
      </div>
      <span className="shrink-0 text-right font-mono text-sm tabular-nums text-ink">{rateLabel(listing)}</span>
    </Link>
  );
}
