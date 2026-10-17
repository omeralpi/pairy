'use client';

import Link from "next/link";
import { useEffect } from "react";
import { toast } from "sonner";

import { ConfirmAction } from "@/components/confirm-action";
import { friendlyError, isUnauthorized } from "@/components/friendly-error";
import { amountRange, rateLabel, sideLabel, type Listing } from "@/components/listing/format";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<Listing["status"], string> = {
  active: "text-success",
  paused: "text-warning",
  closed: "text-slate",
};

function Row({ listing }: { listing: Listing }) {
  const utils = api.useUtils();
  const setStatus = api.listing.setStatus.useMutation({
    onSuccess: () => utils.listing.invalidate(),
    onError: (e) => {
      toast.error(friendlyError(e));
      if (isUnauthorized(e)) void utils.auth.me.invalidate();
    },
  });

  return (
    <li className="py-5">
      <div className="flex items-start justify-between gap-4">
        <Link href={`/listings/${listing.id}`} className="group min-w-0 space-y-1">
          <p className={cn("truncate font-medium underline-offset-4 group-hover:underline", listing.status === "closed" ? "text-slate" : "text-ink")}>
            {sideLabel(listing.side)} {amountRange(listing)}
          </p>
          <p className="text-sm text-slate">
            <span className="font-mono">{rateLabel(listing)}</span> · {listing.cityName}, {listing.countryCode}
          </p>
        </Link>
        <span className={cn("shrink-0 pt-1 font-mono text-[11px] uppercase tracking-[0.18em]", STATUS_STYLE[listing.status])}>
          {listing.status}
        </span>
      </div>
      {listing.status !== "closed" && (
        <div className="mt-3 flex gap-2">
          {listing.status === "active" ? (
            <Button variant="outline" size="sm" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: listing.id, status: "paused" })}>
              Pause
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: listing.id, status: "active" })}>
              Resume
            </Button>
          )}
          <ConfirmAction
            title="Close this listing for good?"
            description="It cannot be reopened. Trades already open on it continue."
            confirmLabel="Close listing"
            onConfirm={() => setStatus.mutate({ id: listing.id, status: "closed" })}
          >
            <Button variant="outline" size="sm" className="text-danger" disabled={setStatus.isPending}>
              Close
            </Button>
          </ConfirmAction>
        </div>
      )}
    </li>
  );
}

export default function MyListingsPage() {
  const utils = api.useUtils();
  const { publicKey, loading } = useSession();
  const { data, isLoading, error } = api.listing.mine.useQuery(undefined, { enabled: !!publicKey });
  const expired = isUnauthorized(error);
  useEffect(() => {
    if (expired) void utils.auth.me.invalidate();
  }, [expired, utils]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 md:py-12">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="eyebrow">Listings</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink md:text-4xl">
            Your <em className="font-serif font-normal">listings.</em>
          </h1>
        </div>
        <Button asChild size="sm">
          <Link href="/listings/new">New listing</Link>
        </Button>
      </div>
      <p className="mt-3 text-sm text-slate">
        Paused listings are hidden from the map until you resume them. Closed is final. Either way, trades already
        open on a listing continue.
      </p>

      <div className="mt-8">
        {loading ? null : !publicKey ? (
          <p className="text-sm text-ink">
            <Link href="/onboard" className="font-medium underline decoration-ink/30 underline-offset-4 hover:decoration-ink">
              Sign in
            </Link>{" "}
            to see your listings.
          </p>
        ) : isLoading ? (
          <p className="text-sm text-slate">Loading…</p>
        ) : error ? (
          <p className="text-sm text-danger">{friendlyError(error)}</p>
        ) : data?.length === 0 ? (
          <p className="text-sm text-slate">You have no listings yet.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {data?.map((l) => <Row key={l.id} listing={l} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
