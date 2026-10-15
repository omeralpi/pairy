'use client';

import Link from "next/link";

import { ListingForm } from "@/components/listing/listing-form";
import { useSession } from "@/lib/auth/use-session";

export default function NewListingPage() {
  const { publicKey, loading } = useSession();

  return (
    <div className="mx-auto max-w-lg px-4 py-6 md:py-10">
      <h1 className="font-display text-2xl font-bold tracking-tight">New listing</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Say what you trade, roughly where, and at what rate. Others find it on the map.
      </p>
      <div className="mt-6">
        {loading ? null : publicKey ? (
          <ListingForm />
        ) : (
          <div className="rounded-2xl border bg-card p-6">
            <p className="font-semibold">Sign in to post a listing</p>
            <p className="mt-1 text-sm text-muted-foreground">
              A listing belongs to a Stellar public key. Connect Freighter or create a testnet wallet on this device;
              the key stays with you.
            </p>
            <Link
              href="/onboard"
              className="mt-4 inline-flex h-11 items-center rounded-full bg-pairy-flame px-5 font-semibold text-white"
            >
              Sign in
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
