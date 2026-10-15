'use client';

import Link from "next/link";
import { toast } from "sonner";

import { amountRange, rateLabel, type Listing } from "@/components/listing/format";
import { SideBadge } from "@/components/listing/listing-card";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<Listing["status"], string> = {
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  paused: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  closed: "bg-muted text-muted-foreground",
};

function Row({ listing }: { listing: Listing }) {
  const utils = api.useUtils();
  const setStatus = api.listing.setStatus.useMutation({
    onSuccess: () => utils.listing.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const action = "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors hover:border-foreground disabled:opacity-50";

  return (
    <li className={cn("rounded-xl border bg-card p-4", listing.status === "closed" && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <Link href={`/listings/${listing.id}`} className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <SideBadge side={listing.side} />
            <span className="truncate font-semibold">{amountRange(listing)}</span>
          </div>
          <p className="text-sm text-muted-foreground">
            {rateLabel(listing)} · {listing.cityName}, {listing.countryCode}
          </p>
        </Link>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold capitalize", STATUS_STYLE[listing.status])}>
          {listing.status}
        </span>
      </div>
      {listing.status !== "closed" && (
        <div className="mt-3 flex gap-2">
          {listing.status === "active" ? (
            <button className={action} disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: listing.id, status: "paused" })}>
              Pause
            </button>
          ) : (
            <button className={action} disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: listing.id, status: "active" })}>
              Resume
            </button>
          )}
          <button
            className={cn(action, "text-destructive")}
            disabled={setStatus.isPending}
            onClick={() => {
              if (confirm("Close this listing for good? It cannot be reopened.")) {
                setStatus.mutate({ id: listing.id, status: "closed" });
              }
            }}
          >
            Close
          </button>
        </div>
      )}
    </li>
  );
}

export default function MyListingsPage() {
  const { publicKey, loading } = useSession();
  const { data, isLoading, error } = api.listing.mine.useQuery(undefined, { enabled: !!publicKey });

  return (
    <div className="mx-auto max-w-2xl px-4 py-6 md:py-10">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold tracking-tight">My listings</h1>
        <Link href="/listings/new" className="rounded-full bg-pairy-flame px-4 py-2 text-sm font-semibold text-white">
          New listing
        </Link>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Paused listings are hidden from the map until you resume them. Closed is final.
      </p>

      <div className="mt-6">
        {loading ? null : !publicKey ? (
          <p className="text-sm">
            <Link href="/onboard" className="font-semibold text-pairy-flame underline">
              Sign in
            </Link>{" "}
            to see your listings.
          </p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="text-sm text-destructive">{error.message}</p>
        ) : data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">You have no listings yet.</p>
        ) : (
          <ul className="space-y-3">
            {data?.map((l) => <Row key={l.id} listing={l} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
