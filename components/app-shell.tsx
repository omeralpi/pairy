'use client';

import { ArrowLeftRight, LayoutList, Map, Plus, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { shortAddress } from "@/components/listing/format";
import { useSession } from "@/lib/auth/use-session";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/map", label: "Map", icon: Map },
  { href: "/trades", label: "Trades", icon: ArrowLeftRight },
  { href: "/listings/mine", label: "Listings", icon: LayoutList },
  { href: "/wallet", label: "Wallet", icon: Wallet },
] as const;

export function TestnetBadge({ className }: { className?: string }) {
  return (
    <span
      title="Stellar testnet only. Nothing here is real money."
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-pairy-flame/40 bg-pairy-flame/10 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-pairy-flame",
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-pairy-flame" />
      Testnet only
    </span>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- static SVG, no optimisation to gain */}
      <img src="/wordmark-light.svg" alt="Pairy" className={cn("h-8 w-auto dark:hidden", className)} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/wordmark-dark.svg" alt="Pairy" className={cn("hidden h-8 w-auto dark:block", className)} />
    </>
  );
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { publicKey } = useSession();

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background/90 px-4 backdrop-blur md:h-16 md:gap-4 md:px-6">
        <Link href="/" className="shrink-0">
          <Wordmark className="h-7 md:h-8" />
        </Link>
        <TestnetBadge />
        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {NAV.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "rounded-full px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                isActive(pathname, href) && "bg-secondary text-foreground",
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href="/listings/new"
            className="hidden items-center gap-1.5 rounded-full bg-pairy-flame px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 md:inline-flex"
          >
            <Plus className="size-4" />
            New listing
          </Link>
          {publicKey ? (
            <Link href="/wallet" className="whitespace-nowrap rounded-full border px-3 py-1.5 font-mono text-xs">
              {shortAddress(publicKey)}
            </Link>
          ) : (
            <Link
              href="/onboard"
              className="rounded-full border px-3 py-1.5 text-sm font-medium transition-colors hover:border-foreground"
            >
              Sign in
            </Link>
          )}
        </div>
      </header>

      <main className="relative flex-1 overflow-y-auto">{children}</main>

      <nav className="grid shrink-0 grid-cols-5 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.slice(0, 2).map((item) => (
          <NavItem key={item.href} {...item} active={isActive(pathname, item.href)} />
        ))}
        <Link href="/listings/new" aria-label="New listing" className="grid place-items-center">
          <span className="grid size-11 place-items-center rounded-full bg-pairy-flame text-white shadow-md">
            <Plus className="size-5" />
          </span>
        </Link>
        {NAV.slice(2).map((item) => (
          <NavItem key={item.href} {...item} active={isActive(pathname, item.href)} />
        ))}
      </nav>
    </div>
  );
}

function NavItem({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: typeof Map;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-muted-foreground",
        active && "text-pairy-flame",
      )}
    >
      <Icon className="size-5" />
      {label}
    </Link>
  );
}
