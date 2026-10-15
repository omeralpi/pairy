import Link from "next/link";

import { Lockup } from "@/components/brand/waypoint";
import { Button } from "@/components/ui/button";

const LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#how-its-safe", label: "How it's safe" },
  { href: "#why-pairy", label: "Why Pairy" },
];

/** Floating pill nav for the landing page. Collapses to mark + "Open the app" on phones. */
export function SiteNav() {
  return (
    <header className="sticky top-4 z-50 flex justify-center px-4">
      <nav className="flex w-full max-w-3xl items-center gap-2 rounded-full bg-white py-2 pl-5 pr-2 shadow-[0_10px_30px_-12px_rgba(14,17,22,0.18)] sm:w-auto sm:gap-8">
        <Link href="/" aria-label="Pairy home">
          <Lockup markClassName="text-beacon" />
        </Link>
        <ul className="hidden items-center gap-8 text-sm text-ink md:flex">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a href={l.href} className="transition-colors hover:text-slate">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <Button asChild className="ml-auto sm:ml-0">
          <Link href="/map">Open the app</Link>
        </Button>
      </nav>
    </header>
  );
}
