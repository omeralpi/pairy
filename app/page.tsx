import { ArrowRight } from "lucide-react";
import Link from "next/link";

import { Lockup } from "@/components/brand/waypoint";
import { CityRotator } from "@/components/landing/city-rotator";
import { SiteNav } from "@/components/landing/site-nav";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    title: "Find a peer.",
    body: "Open the map, pick a listing in your city, and agree a rate and a meeting point in that trade's own chat.",
  },
  {
    title: "Meet.",
    body: "Go to the meeting point. Lock nothing until you are both standing there.",
  },
  {
    title: "The seller locks it.",
    body: "The seller locks the XLM or USDC for the buyer. From that moment the buyer can claim it, cash or not.",
  },
  {
    title: "Cash, then claim.",
    body: "Hand over the cash. The buyer claims it on their own phone. Settled.",
  },
];

const WHY = [
  {
    title: "No more hoping.",
    body: "Cash deals on Telegram and WhatsApp have no recourse: if the other side never sends, the money is gone. Pairy is the in-person version, with a lock only the two of you control.",
  },
  {
    title: "No Pairy fee.",
    body: "The only cost is the Stellar network fee on each step.",
    figure: "100 stroops ≈ 0.00001 XLM",
  },
  {
    title: "No sign-up.",
    body: "No account, no name, no phone number. Just a key on your phone.",
  },
];

const EXTERNAL = { target: "_blank", rel: "noreferrer" } as const;

function Eyebrow({ n, children, className }: { n: string; children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("eyebrow", className)}>
      {n} · {children}
    </p>
  );
}

export default function Home() {
  return (
    <div className="min-h-dvh overflow-x-clip bg-paper text-ink">
      <SiteNav />

      {/* Hero */}
      <section className="mx-auto flex min-h-[calc(100svh-5rem)] max-w-[1400px] flex-col px-4 md:px-10">
        <div className="flex flex-1 items-center py-16">
          <div className="flex w-full flex-col gap-2 md:flex-row md:items-center md:gap-[0.25em] md:text-[min(9vw,140px)]">
            <h1 className="shrink-0 text-[64px] font-bold leading-none tracking-tight sm:text-[88px] md:text-[1em]">
              Trade in<span className="sr-only"> your city.</span>
            </h1>
            {/* Shift the stack so the beacon city shares a baseline with "Trade in" (measured at rest: 0.17em down). */}
            <CityRotator className="min-w-0 text-[48px] sm:text-[72px] md:translate-y-[0.17em] md:text-[0.86em]" />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 pb-10">
          <p className="text-slate">
            <strong className="font-semibold text-ink">Stellar testnet demo</strong> · no real money
          </p>
          <Button asChild size="lg">
            <Link href="/map">
              Pick yours <ArrowRight strokeWidth={1.5} />
            </Link>
          </Button>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="scroll-mt-24 border-t border-line">
        <div className="mx-auto max-w-[1400px] px-4 py-24 md:px-10 md:py-32">
          <Eyebrow n="01">How it works</Eyebrow>
          <h2 className="mt-4 max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
            Four steps, <em className="font-serif font-normal">one meeting.</em>
          </h2>

          <ol className="mt-16 grid gap-10 md:grid-cols-4 md:gap-8">
            {STEPS.map((s, i) => (
              <li key={s.title} className="border-t border-line pt-6">
                <span className="font-mono text-sm text-slate">{String(i + 1).padStart(2, "0")}</span>
                <h3 className="mt-6 text-xl font-semibold">{s.title}</h3>
                <p className="mt-3 leading-relaxed text-slate">{s.body}</p>
              </li>
            ))}
          </ol>

          <div className="mt-16 flex flex-col gap-6 border-t border-line pt-8 md:flex-row md:items-center md:justify-between">
            <p className="max-w-2xl leading-relaxed text-slate">
              If the buyer never claims, the seller takes it back after <span className="font-mono text-ink">72 hours</span>.
              Until then only the buyer can claim, so lock only when you are both at the meeting point.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button asChild>
                <Link href="/map">Open the map</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/listings/new">Post a listing</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* How it's safe */}
      <section id="how-its-safe" className="scroll-mt-24 bg-ink text-paper">
        <div className="mx-auto max-w-[1400px] px-4 py-24 md:px-10 md:py-32">
          <Eyebrow n="02" className="text-mist">
            How it&apos;s safe
          </Eyebrow>
          <h2 className="mt-4 max-w-4xl text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
            Two people on the lock. <em className="whitespace-nowrap font-serif font-normal">Not us.</em>
          </h2>

          <div className="mt-16 grid gap-16 md:grid-cols-[1.1fr_1fr] md:gap-24">
            <dl className="border-t border-paper/15">
              <div className="flex items-baseline justify-between gap-6 border-b border-paper/15 py-5">
                <dt className="eyebrow text-mist">Buyer</dt>
                <dd className="text-right text-lg">can claim for 72 hours</dd>
              </div>
              <div className="flex items-baseline justify-between gap-6 border-b border-paper/15 py-5">
                <dt className="eyebrow text-mist">Seller</dt>
                <dd className="text-right text-lg">can take it back after that</dd>
              </div>
              <div className="flex items-baseline justify-between gap-6 border-b border-paper/15 py-5">
                <dt className="eyebrow text-mist">Pairy</dt>
                <dd className="text-right text-lg text-mist">not on it</dd>
              </div>
            </dl>

            <div className="space-y-6 text-lg leading-relaxed text-paper/80">
              <p>
                No third party, no platform key, nobody who can redirect the funds. Pairy holds no key and cannot move
                the money.
              </p>
              <p>
                Your key is made on your phone and never leaves it. If you use Freighter, it stays in Freighter.
              </p>
            </div>
          </div>

          <div className="mt-16 grid gap-8 border-t border-paper/15 pt-8 md:grid-cols-[1.1fr_1fr] md:gap-24">
            <p className="leading-relaxed text-paper/80">
              <span className="font-semibold text-paper">The honest limit.</span> Pairy protects the buyer against a
              seller who takes the cash and never sends. It protects the seller only against a buyer who never claims,
              not against theft.
            </p>
            <p className="font-mono text-sm leading-relaxed text-mist">
              Check it yourself: every lock and claim has a receipt on{" "}
              <a
                href="https://stellar.expert/explorer/testnet"
                {...EXTERNAL}
                className="text-paper underline decoration-paper/30 underline-offset-4 hover:decoration-paper"
              >
                stellar.expert
              </a>
              .
            </p>
          </div>
        </div>
      </section>

      {/* Why Pairy */}
      <section id="why-pairy" className="scroll-mt-24">
        <div className="mx-auto max-w-[1400px] px-4 py-24 md:px-10 md:py-32">
          <Eyebrow n="03">Why Pairy</Eyebrow>
          <h2 className="mt-4 max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
            Cash deals, <em className="font-serif font-normal">with a lock.</em>
          </h2>

          <div className="mt-16 grid gap-10 md:grid-cols-3 md:gap-8">
            {WHY.map((w) => (
              <div key={w.title} className="border-t border-line pt-6">
                <h3 className="text-xl font-semibold">{w.title}</h3>
                <p className="mt-3 leading-relaxed text-slate">{w.body}</p>
                {w.figure && <p className="mt-4 font-mono text-sm text-ink">{w.figure}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-line">
        <div className="mx-auto max-w-[1400px] px-4 py-16 md:px-10">
          <div className="flex flex-col gap-10 md:flex-row md:items-end md:justify-between">
            <div>
              <Lockup />
              <p className="mt-3 font-serif text-2xl italic">— Trade in person.</p>
            </div>
            <ul className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
              <li>
                <Link href="/map" className="hover:text-slate">
                  The map
                </Link>
              </li>
              <li>
                <a href="https://github.com/omeralpi/pairy" {...EXTERNAL} className="hover:text-slate">
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/omeralpi/pairy/blob/main/EVIDENCE.md"
                  {...EXTERNAL}
                  className="font-mono hover:text-slate"
                >
                  EVIDENCE.md
                </a>
              </li>
            </ul>
          </div>

          <div className="mt-12 space-y-2 border-t border-line pt-6 text-xs leading-relaxed text-slate">
            <p className="font-mono uppercase tracking-[0.18em]">Stellar testnet · reference implementation · MIT</p>
            <p>Pairy has zero users. This is a reference implementation, not a product in use.</p>
            <p>
              Map ©{" "}
              <a className="underline underline-offset-2" href="https://openfreemap.org" {...EXTERNAL}>
                OpenFreeMap
              </a>{" "}
              ·{" "}
              <a className="underline underline-offset-2" href="https://www.openstreetmap.org/copyright" {...EXTERNAL}>
                OpenStreetMap
              </a>{" "}
              contributors · Cities from{" "}
              <a className="underline underline-offset-2" href="https://www.geonames.org/" {...EXTERNAL}>
                GeoNames
              </a>{" "}
              (
              <a
                className="underline underline-offset-2"
                href="https://creativecommons.org/licenses/by/4.0/"
                {...EXTERNAL}
              >
                CC BY 4.0
              </a>
              )
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
