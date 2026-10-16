import { cn } from "@/lib/utils";

// The Waypoint, drawn from the brand construction: a 100×100u grid, ring
// centred at 50,50 with radius 41u and stroke 5u, dot radius 12.5u. Always
// render it from here; never re-derive the geometry by eye.
export function Waypoint({ className, title = "Pairy" }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={cn("size-6", className)} role="img" aria-label={title}>
      <circle cx="50" cy="50" r="41" fill="none" stroke="currentColor" strokeWidth="5" />
      <circle cx="50" cy="50" r="12.5" fill="currentColor" />
    </svg>
  );
}

/**
 * The app icon: the ink Waypoint on a Line (#E6E3DC) tile with 22% corners
 * (assets/app-icon.svg). It is the default mark everywhere the logo appears.
 * Below ~48px the ring and dot are drawn heavier so they don't disappear.
 */
export function AppIcon({ className, title = "Pairy", small = true }: { className?: string; title?: string; small?: boolean }) {
  return (
    <svg viewBox="0 0 320 320" className={cn("size-7 shrink-0", className)} role="img" aria-label={title || undefined} aria-hidden={title ? undefined : true}>
      <rect width="320" height="320" rx="70.4" fill="#E6E3DC" />
      <circle cx="160" cy="160" r="81.5" fill="none" stroke="#0E1116" strokeWidth={small ? 16 : 9} />
      <circle cx="160" cy="160" r={small ? 30 : 25} fill="#0E1116" />
    </svg>
  );
}

/** App icon + wordmark. */
export function Lockup({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 font-sans text-lg font-bold tracking-tight", className)}>
      <AppIcon className={markClassName} title="" />
      Pairy
    </span>
  );
}
