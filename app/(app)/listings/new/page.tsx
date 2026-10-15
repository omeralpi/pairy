'use client';

import Link from "next/link";

import { ListingForm } from "@/components/listing/listing-form";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth/use-session";

export default function NewListingPage() {
  const { publicKey, loading } = useSession();

  return (
    <div className="mx-auto max-w-lg px-4 py-6 md:py-12">
      <p className="eyebrow">Listings</p>
      <h1 className="mt-2 text-3xl font-bold tracking-tight text-ink md:text-4xl">
        New <em className="font-serif font-normal">listing.</em>
      </h1>
      <p className="mt-3 text-slate">
        Say what you trade, in which city, and at what rate. Others find it on the map.
      </p>
      <div className="mt-10">
        {loading ? null : publicKey ? (
          <ListingForm />
        ) : (
          <div className="rounded-xl bg-sand p-6">
            <p className="font-semibold text-ink">Sign in to post a listing.</p>
            <p className="mt-2 text-sm text-slate">
              A listing belongs to a Stellar public key. Connect Freighter or create a testnet wallet on this device;
              the key stays with you.
            </p>
            <Button asChild className="mt-5">
              <Link href="/onboard">Sign in</Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
