import type { RouterOutputs } from "@/lib/api";
import type { TradeRole, TradeState } from "@/lib/trade/state-machine";

export type TradeView = RouterOutputs["trade"]["byId"];

export const STATE_LABEL: Record<TradeState, string> = {
  listed: "Waiting for agreement",
  agreed: "Agreed — lock at the meeting",
  locked: "Locked on-chain",
  claimed: "Claimed by the buyer",
  reclaimed: "Reclaimed by the seller",
  cancelled: "Cancelled",
};

export const STATE_STYLE: Record<TradeState, string> = {
  listed: "bg-secondary text-foreground",
  agreed: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  locked: "bg-pairy-flame/15 text-pairy-flame",
  claimed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  reclaimed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  cancelled: "bg-muted text-muted-foreground",
};

export const roleName = (r: TradeRole) => (r === "seller" ? "Seller" : "Buyer");

/** 259200 → "72 hours", 60 → "60 seconds". */
export function windowLabel(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

/** 259200 → "72h", 60 → "1m". */
export function windowShort(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}h ${pad(m)}m ${pad(s % 60)}s`;
}

export const btnPrimary =
  "inline-flex items-center justify-center gap-2 rounded-full bg-pairy-flame px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";
export const btnSecondary =
  "inline-flex items-center justify-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors hover:border-foreground disabled:cursor-not-allowed disabled:opacity-50";
