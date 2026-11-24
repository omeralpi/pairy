'use client';

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AcceptanceScreen } from "@/components/escrow/acceptance-screen";
import { friendlyError } from "@/components/friendly-error";
import { belowMinimum, normalizeDecimal, trimAmount } from "@/components/listing/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useSession } from "@/lib/auth/use-session";
import { ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { ASSETS } from "@/lib/stellar/assets";
import { amountInput, fiatTotal, fromStroops, toStroops } from "@/lib/trade/amount";
import type { TradeMode } from "@/lib/trade/state-machine";
import { useWallet, type WalletKind } from "@/lib/wallet/use-wallet";

/** For the sentence that says which wallets can open a protected trade. */
const KIND_NAME: Record<WalletKind, string> = {
  device: "a key on this device",
  freighter: "Varial (formerly Freighter)",
  privy: "an email wallet",
};

/** On the listing page: pick an amount inside the listing's bounds and open a trade. */
export function StartTradeButton({ listingId }: { listingId: string }) {
  const router = useRouter();
  const { publicKey, loading } = useSession();
  const { wallet, ready } = useWallet();
  const { data: listing } = api.listing.byId.useQuery({ id: listingId });
  const { data: config } = api.escrow.config.useQuery();
  const [amount, setAmount] = useState("");
  // Always starts off (DECISIONS 6); turning it on shows the terms to accept.
  const [mode, setMode] = useState<TradeMode>("claimable");
  const [accepted, setAccepted] = useState(false);
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
  if (belowMinimum(listing)) {
    return (
      <p className="text-sm text-slate">
        Not enough left on this listing right now. It comes back when a trade on it is cancelled.
      </p>
    );
  }

  // Open trades reserve part of the total, so the upper bound is what is left.
  const maxStroops =
    toStroops(listing.remainingAmount) < toStroops(listing.maxAmount)
      ? toStroops(listing.remainingAmount)
      : toStroops(listing.maxAmount);
  const min = trimAmount(listing.minAmount);
  const max = fromStroops(maxStroops);
  // Normalized on use, not while typing: "1," must not turn into "1." before
  // the user has typed the "000" that makes it a thousands separator.
  const value = normalizeDecimal(amount);
  const parsed = amountInput.safeParse(value);
  const inBounds =
    parsed.success && toStroops(parsed.data) >= toStroops(listing.minAmount) && toStroops(parsed.data) <= maxStroops;
  const youAre = listing.side === "sell_crypto" ? "buyer" : "seller";

  // A protected trade needs the switch on (DECISIONS 6), a USDC listing and a
  // wallet kind that can sign the escrow. With the switch off, or while it or
  // the wallet is loading, nothing is said about protected trades; otherwise
  // the toggle shows, or the reason it can't.
  const kinds = config?.enabled && ready ? config.protectedWalletKinds : null;
  const protectedProblem = !kinds
    ? null
    : !ASSETS[listing.asset].protectedMode
      ? "Protected trades work with USDC only for now."
      : !wallet
        ? "Connect your wallet to choose a protected trade."
        : !kinds.includes(wallet.kind)
          ? `Protected trades work with ${kinds.map((k) => KIND_NAME[k]).join(" or ")} for now.`
          : null;
  const showToggle = kinds !== null && protectedProblem === null;
  const isProtected = showToggle && mode === "protected";
  const canStart = inBounds && (!isProtected || accepted);

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canStart) return;
        open.mutate(
          isProtected
            ? { listingId, amount: value, mode: "protected", acceptanceVersion: ACCEPTANCE_VERSION }
            : { listingId, amount: value },
        );
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
        aria-invalid={!!amount && !inBounds}
        aria-describedby="trade-amount-hint"
      />
      <p id="trade-amount-hint" className="text-sm text-slate">
        {inBounds
          ? `${fiatTotal(value, listing.rate)} ${listing.fiatCode} in cash. `
          : /[,\s]/.test(value)
            ? "Use a dot for decimals and no thousands separators, e.g. 1000.5. "
            : amount
              ? `Enter ${min} to ${max} ${listing.asset}. `
              : ""}
        You will be the {youAre}. Opening a trade moves no money; your peer has to agree first.
      </p>
      {showToggle && (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 text-sm leading-relaxed">
          <input
            id="protected-trade"
            type="checkbox"
            className="mt-1 size-4 shrink-0 accent-ink"
            checked={mode === "protected"}
            onChange={(e) => setMode(e.target.checked ? "protected" : "claimable")}
          />
          <span>
            <span className="font-medium text-ink">Protected trade</span>
            <span className="block text-slate">The USDC goes into a Trustless Work escrow instead of the usual lock.</span>
          </span>
        </label>
      )}
      {protectedProblem && <p className="text-sm text-slate">{protectedProblem}</p>}
      {isProtected && <AcceptanceScreen accepted={accepted} onAcceptedChange={setAccepted} />}
      {open.error && <p className="text-sm text-danger [overflow-wrap:anywhere]">{friendlyError(open.error)}</p>}
      <Button type="submit" disabled={!canStart || open.isPending}>
        {open.isPending ? "Opening…" : isProtected ? "Accept and start protected trade" : "Start trade"}
      </Button>
    </form>
  );
}
