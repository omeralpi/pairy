import type { RouterOutputs } from "@/lib/api";
import type { TradeRole, TradeState } from "@/lib/trade/state-machine";

export type TradeView = RouterOutputs["trade"]["byId"];

/** Group headers on the trades list (set as eyebrows). */
export const STATE_LABEL: Record<TradeState, string> = {
  listed: "Waiting to agree",
  agreed: "Agreed",
  locked: "Locked",
  claimed: "Settled",
  reclaimed: "Taken back",
  cancelled: "Cancelled",
};

export const roleName = (r: TradeRole) => (r === "seller" ? "Seller" : "Buyer");

/** Where a trade stands, as one plain sentence from the viewer's side. */
export function statusSentence(t: { state: TradeState; role: TradeRole; openedBy: TradeRole; asset: string }): string {
  switch (t.state) {
    case "listed":
      // The side that did not open the trade is the one that agrees to it.
      return t.role === t.openedBy
        ? `Waiting for the ${t.role === "seller" ? "buyer" : "seller"} to agree.`
        : "Waiting for you to agree.";
    case "agreed":
      return "Agreed. Lock when you're both at the meeting point.";
    case "locked":
      return t.role === "buyer"
        ? "It's locked for you. Hand over the cash, then claim."
        : "Locked. The buyer can claim once you have the cash.";
    case "claimed":
      return t.role === "buyer"
        ? `Settled. The ${t.asset} is in your wallet.`
        : `Settled. The ${t.asset} is in the buyer's wallet.`;
    case "reclaimed":
      return t.role === "seller"
        ? `Taken back. The ${t.asset} is back in your wallet.`
        : `Taken back. The ${t.asset} went back to the seller.`;
    case "cancelled":
      return "Cancelled. Nothing was locked.";
  }
}

/** 259200 → "72 hours", 60 → "1 minute". */
export function windowLabel(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  if (seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

/** 259200 → "72 h", 60 → "1 min". */
export function windowShort(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/** Milliseconds → "71:59:54". */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
}

/** Cash per one unit of the asset, e.g. "12.5". */
export function rateOf(amount: string, fiatAmount: string): string {
  const a = Number(amount);
  return a > 0 ? (Number(fiatAmount) / a).toLocaleString("en-US", { maximumFractionDigits: 4 }) : "–";
}

/** "16 Oct, 14:05" */
export const shortWhen = (d: Date | number) =>
  new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
