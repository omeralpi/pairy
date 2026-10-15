'use client';

import { ArrowLeftRight, LayoutList, Map, Plus, Wallet } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Lockup } from "@/components/brand/waypoint";
import { shortAddress } from "@/components/listing/format";
import { useSession } from "@/lib/auth/use-session";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/map", label: "Map", icon: Map },
  { href: "/trades", label: "Trades", icon: ArrowLeftRight },
  { href: "/listings/mine", label: "Listings", icon: LayoutList },
  { href: "/wallet", label: "Wallet", icon: Wallet },
] as const;

/** A quiet label, not a pill: the whole app runs on Stellar testnet. */
function TestnetBadge({ className }: { className?: string }) {
  return (
    <span
      title="Stellar testnet only. Nothing here is real money."
      className={cn("eyebrow shrink-0 whitespace-nowrap", className)}
    >
      Testnet
    </span>
  );
}

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { publicKey } = useSession();

  return (
    <div className="flex h-dvh flex-col bg-paper text-ink">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-paper px-4 md:h-16 md:gap-6 md:px-8">
        <Link href="/" className="shrink-0">
          <Lockup />
        </Link>
        <TestnetBadge className="pt-0.5" />
        <nav className="ml-2 hidden items-center gap-6 md:flex">
          {NAV.map(({ href, label }) => {
            const active = isActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "border-b py-1 text-sm transition-colors",
                  active ? "border-ink font-medium text-ink" : "border-transparent text-slate hover:text-ink",
                )}
              >
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <Link
            href="/listings/new"
            className="hidden items-center gap-1.5 text-sm font-medium text-ink underline-offset-4 hover:underline md:inline-flex"
          >
            <Plus className="size-4" strokeWidth={1.5} />
            New listing
          </Link>
          {publicKey ? (
            <Link
              href="/wallet"
              title={publicKey}
              className="whitespace-nowrap rounded-full border border-line px-3 py-1.5 font-mono text-xs text-ink transition-colors hover:border-ink/40"
            >
              {shortAddress(publicKey)}
            </Link>
          ) : (
            <Link
              href="/onboard"
              className="inline-flex h-9 items-center rounded-full bg-ink px-4 text-sm font-medium text-paper transition-colors hover:bg-deep"
            >
              Sign in
            </Link>
          )}
        </div>
      </header>

      <main className="relative flex-1 overflow-y-auto">{children}</main>

      <nav className="grid shrink-0 grid-cols-5 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.slice(0, 2).map((item) => (
          <NavItem key={item.href} {...item} active={isActive(pathname, item.href)} />
        ))}
        <Link href="/listings/new" aria-label="New listing" className="grid place-items-center">
          <span className="grid size-11 place-items-center rounded-full bg-ink text-paper">
            <Plus className="size-5" strokeWidth={1.5} />
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
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex flex-col items-center gap-1 py-2.5 text-[11px] text-slate",
        active && "font-medium text-ink",
      )}
    >
      <Icon className="size-5" strokeWidth={1.5} />
      {label}
    </Link>
  );
}
