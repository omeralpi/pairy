import { ArrowRight, Check, X } from "lucide-react";
import Link from "next/link";

import { TestnetBadge, Wordmark } from "@/components/app-shell";

const STEPS = [
  {
    title: "Find someone nearby",
    body: "Listings sit on a map at city level. Pick one that matches what you have and what you want.",
  },
  {
    title: "Agree the terms",
    body: "Amount, rate and meeting point, in a chat that belongs to that one trade. It is deleted when the trade ends.",
  },
  {
    title: "Seller locks the crypto",
    body: "At the meeting, the seller puts the crypto in a Stellar claimable balance with two claimants: the buyer and themselves.",
  },
  {
    title: "Buyer claims on their phone",
    body: "Cash changes hands, and the buyer claims the balance, signed on their own device. If they never claim, the seller takes it back after 72 hours.",
  },
];

const STORED = ["Stellar public keys", "Listing terms", "Claimable balance IDs and transaction hashes", "Trade state"];
const NOT_STORED = [
  "Private keys, or anything a key could be derived from",
  "Names, phone numbers, ID documents, KYC data",
  "Your live or precise location",
  "Chat, once the trade is finished",
];

function Claimant({ who, predicate, plain }: { who: string; predicate: string; plain: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold">{who}</span>
        <code className="rounded-md bg-pairy-flame/15 px-2 py-0.5 font-mono text-[11px] text-pairy-flame">{predicate}</code>
      </div>
      <p className="mt-1.5 text-sm text-pairy-cream/60">{plain}</p>
    </div>
  );
}

export default function Home() {
  return (
    <div className="min-h-dvh">
      <section className="relative overflow-hidden bg-pairy-ink text-pairy-cream">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-40 -top-40 size-[34rem] rounded-full border-[3.5rem] border-pairy-flame/10"
        />
        <header className="relative mx-auto flex max-w-6xl items-center gap-3 px-5 py-5 md:px-8">
          {/* eslint-disable-next-line @next/next/no-img-element -- static SVG */}
          <img src="/wordmark-dark.svg" alt="Pairy" className="h-8 w-auto" />
          <TestnetBadge />
          <Link
            href="/map"
            className="ml-auto hidden whitespace-nowrap rounded-full border border-pairy-cream/20 px-4 py-2 sm:inline-flex text-sm font-medium transition-colors hover:border-pairy-cream/60"
          >
            Open the map
          </Link>
        </header>

        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-20 pt-10 md:grid-cols-[1.1fr_1fr] md:px-8 md:pb-28 md:pt-16">
          <div>
            <h1 className="font-display text-5xl font-bold leading-[0.95] tracking-tight md:text-7xl">
              Trade cash for crypto, <span className="text-pairy-flame">in person.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-pairy-cream/75">
              Pairy helps two people near each other swap local cash for XLM or USDC face to face. The seller locks the
              crypto on Stellar; the buyer claims it on their own device once the cash is in their hand.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                href="/map"
                className="inline-flex h-12 items-center gap-2 rounded-full bg-pairy-flame px-6 font-semibold text-white transition-opacity hover:opacity-90"
              >
                See listings on the map <ArrowRight className="size-4" />
              </Link>
              <Link
                href="/listings/new"
                className="inline-flex h-12 items-center rounded-full border border-pairy-cream/20 px-6 font-semibold transition-colors hover:border-pairy-cream/60"
              >
                Post a listing
              </Link>
            </div>
            <p className="mt-6 text-sm text-pairy-cream/50">
              Stellar testnet only. No real money. Pairy has zero users: this is a reference implementation, not a
              product in use.
            </p>
          </div>

          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 shadow-2xl backdrop-blur md:p-6">
            <p className="text-xs font-semibold uppercase tracking-wider text-pairy-cream/50">The lock, as it appears on chain</p>
            <p className="mt-1 font-display text-xl font-bold">Claimable balance · 120 USDC</p>
            <div className="mt-4 space-y-3">
              <Claimant
                who="Buyer"
                predicate="before relative time 259200"
                plain="Can claim at any moment in the first 72 hours."
              />
              <Claimant
                who="Seller"
                predicate="not before relative time 259200"
                plain="Can take it back only after the 72 hours are up."
              />
            </div>
            <div className="mt-5">
              <div className="flex h-2 overflow-hidden rounded-full">
                <div className="w-3/4 bg-pairy-flame" />
                <div className="w-1/4 bg-pairy-cream/30" />
              </div>
              <div className="mt-1.5 flex justify-between text-[11px] text-pairy-cream/50">
                <span>Locked</span>
                <span>72 h: seller may reclaim</span>
              </div>
            </div>
            <p className="mt-4 text-xs text-pairy-cream/50">
              No third claimant, no platform address, no dispute resolver. Illustration; amounts vary per trade.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 md:px-8 md:py-24">
        <h2 className="font-display text-3xl font-bold tracking-tight md:text-4xl">How a trade works</h2>
        <ol className="mt-10 grid gap-4 md:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl border bg-card p-5">
              <span className="grid size-8 place-items-center rounded-full bg-pairy-flame font-display text-sm font-bold text-white">
                {i + 1}
              </span>
              <h3 className="mt-4 font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>

        <div className="mt-6 rounded-2xl border-2 border-pairy-flame/40 bg-pairy-flame/5 p-5 md:p-6">
          <h3 className="font-semibold">Read this before you lock</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Once the seller locks, the buyer can claim at any moment inside 72 hours, whether or not cash has changed
            hands. So lock only when both of you are standing at the meeting point. Pairy never sees the cash and cannot
            verify it. This protects the buyer against a seller who takes the cash and never sends. It protects the
            seller only against a buyer who does nothing, not against theft.
          </p>
        </div>
      </section>

      <section className="border-t bg-secondary/40">
        <div className="mx-auto grid max-w-6xl gap-10 px-5 py-16 md:grid-cols-[1fr_1.4fr] md:px-8 md:py-24">
          <div>
            <h2 className="font-display text-3xl font-bold tracking-tight md:text-4xl">Pairy holds no key.</h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">
              Your key is made on your own device, or lives in your Freighter wallet. Pairy has no role on chain: it is
              not a claimant, not a signer and not an arbiter. Every settlement step can be checked on stellar.expert.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border bg-card p-5">
              <h3 className="font-semibold">What Pairy stores</h3>
              <ul className="mt-3 space-y-2 text-sm">
                {STORED.map((s) => (
                  <li key={s} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                    {s}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-2xl border bg-card p-5">
              <h3 className="font-semibold">What it does not</h3>
              <ul className="mt-3 space-y-2 text-sm">
                {NOT_STORED.map((s) => (
                  <li key={s} className="flex gap-2">
                    <X className="mt-0.5 size-4 shrink-0 text-pairy-flame" />
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 py-16 text-center md:px-8 md:py-24">
        <h2 className="font-display text-3xl font-bold tracking-tight md:text-4xl">See who trades what, and roughly where.</h2>
        <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
          Pins are cities, never people. Plan ahead for a city you are travelling to.
        </p>
        <Link
          href="/map"
          className="mt-8 inline-flex h-12 items-center gap-2 rounded-full bg-pairy-flame px-6 font-semibold text-white transition-opacity hover:opacity-90"
        >
          Open the map <ArrowRight className="size-4" />
        </Link>
      </section>

      <footer className="border-t">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-6 text-xs text-muted-foreground md:px-8">
          <Wordmark className="h-6" />
          <span>Stellar testnet reference implementation. MIT licensed.</span>
          <span>
            Map ©{" "}
            <a className="underline" href="https://openfreemap.org" target="_blank" rel="noreferrer">
              OpenFreeMap
            </a>{" "}
            ·{" "}
            <a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              OpenStreetMap
            </a>{" "}
            contributors · Cities from{" "}
            <a className="underline" href="https://www.geonames.org/" target="_blank" rel="noreferrer">
              GeoNames
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
