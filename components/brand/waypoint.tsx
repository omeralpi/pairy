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

/** Mark + wordmark. The mark takes the beacon colour only on ink or as the nav accent. */
export function Lockup({ className, markClassName }: { className?: string; markClassName?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-sans text-lg font-bold tracking-tight", className)}>
      <Waypoint className={cn("size-6", markClassName)} title="" />
      Pairy
    </span>
  );
}
