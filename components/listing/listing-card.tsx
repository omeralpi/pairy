import { ArrowUpRight, MapPin } from "lucide-react";
import Link from "next/link";

import { cn } from "@/lib/utils";

import { amountRange, rateLabel, sideLabel, type Listing } from "./format";

export function SideBadge({ side }: { side: Listing["side"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        side === "sell_crypto" ? "bg-pairy-flame text-white" : "bg-foreground text-background",
      )}
    >
      {sideLabel(side)}
    </span>
  );
}

export function ListingCard({ listing, showCity = true }: { listing: Listing; showCity?: boolean }) {
  return (
    <Link
      href={`/listings/${listing.id}`}
      className="group flex items-center gap-3 rounded-xl border bg-card p-3 transition-colors hover:border-pairy-flame/60"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <SideBadge side={listing.side} />
          <span className="truncate font-semibold">{amountRange(listing)}</span>
        </div>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span className="tabular-nums">{rateLabel(listing)}</span>
          {showCity && (
            <span className="flex min-w-0 items-center gap-1 truncate">
              <MapPin className="size-3.5 shrink-0" />
              {listing.cityName}, {listing.countryCode}
            </span>
          )}
        </div>
      </div>
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-pairy-flame" />
    </Link>
  );
}
