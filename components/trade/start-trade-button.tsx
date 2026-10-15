'use client';

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { trimAmount } from "@/components/listing/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { amountInput, fiatTotal, toStroops } from "@/lib/trade/amount";

/** On the listing page: pick an amount inside the listing's bounds and open a trade. */
export function StartTradeButton({ listingId }: { listingId: string }) {
  const router = useRouter();
  const { publicKey, loading } = useSession();
  const { data: listing } = api.listing.byId.useQuery({ id: listingId });
  const [amount, setAmount] = useState("");
  const open = api.trade.open.useMutation({ onSuccess: (t) => router.push(`/trades/${t.id}`) });

  if (loading || !listing) return null;
  if (!publicKey) {
    return (
      <Button asChild>
        <Link href="/onboard">Sign in to trade</Link>
      </Button>
    );
  }
  if (listing.owner === publicKey) return <p className="text-sm text-slate">This is your listing.</p>;
  if (listing.status !== "active") {
    return <p className="text-sm text-slate">This listing is not taking trades right now.</p>;
  }

  const min = trimAmount(listing.minAmount);
  const max = trimAmount(listing.maxAmount);
  const parsed = amountInput.safeParse(amount);
  const inBounds =
    parsed.success &&
    toStroops(parsed.data) >= toStroops(listing.minAmount) &&
    toStroops(parsed.data) <= toStroops(listing.maxAmount);
  const youAre = listing.side === "sell_crypto" ? "buyer" : "seller";

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (inBounds) open.mutate({ listingId, amount: amount.trim() });
      }}
    >
      <label htmlFor="trade-amount" className="eyebrow block">
        Amount · <span className="normal-case tracking-normal">{min} to {max} {listing.asset}</span>
      </label>
      <Input
        id="trade-amount"
        inputMode="decimal"
        placeholder={min}
        className="font-mono"
        value={amount}
        onChange={(e) => setAmount(e.target.value.trim())}
      />
      <p className="text-sm text-slate">
        {inBounds
          ? `${fiatTotal(amount, listing.rate)} ${listing.fiatCode} in cash. `
          : amount
            ? `Enter an amount between ${min} and ${max} ${listing.asset}. `
            : ""}
        You will be the {youAre}. Opening a trade moves no money; your peer has to agree first.
      </p>
      {open.error && <p className="text-sm text-danger">{open.error.message}</p>}
      <Button type="submit" disabled={!inBounds || open.isPending}>
        {open.isPending ? "Opening…" : "Start trade"}
      </Button>
    </form>
  );
}
