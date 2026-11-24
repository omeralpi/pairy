import type { RouterOutputs } from "@/lib/api";
import { toStroops } from "@/lib/trade/amount";

export type Listing = RouterOutputs["listing"]["list"][number];

/** From the owner's side: a sell_crypto owner is selling crypto for cash. */
export function sideLabel(side: Listing["side"]): string {
  return side === "sell_crypto" ? "Selling" : "Buying";
}

export function shortAddress(publicKey: string): string {
  return `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`;
}

/**
 * What a user typed into an amount or rate field, in the form the server
 * accepts: "12,5" (a decimal comma, as in TRY, BRL, ARS) becomes "12.5" and
 * ".5" becomes "0.5". A comma followed by exactly three digits ("1,000") may
 * be a thousands separator, so it is left alone for validation to reject.
 */
export function normalizeDecimal(v: string): string {
  let s = v.trim();
  if (!s.includes(".") && s.split(",").length === 2 && !/,\d{3}$/.test(s)) s = s.replace(",", ".");
  return s.startsWith(".") ? `0${s}` : s;
}

/** Drop the trailing zeros numeric(20, 7) pads with. */
export function trimAmount(v: string): string {
  return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
}

/** A balance cut (never rounded up) to cents, en-US grouped: "9999.9999999" → "9,999.99". */
export function balanceLabel(v: string): string {
  const [int, frac = ""] = v.split(".");
  return `${int.replace(/\B(?=(\d{3})+$)/g, ",")}.${frac.slice(0, 2).padEnd(2, "0")}`;
}

export function amountRange(l: Pick<Listing, "minAmount" | "maxAmount" | "asset">): string {
  const min = trimAmount(l.minAmount);
  const max = trimAmount(l.maxAmount);
  return min === max ? `${min} ${l.asset}` : `${min} to ${max} ${l.asset}`;
}

/** "40 of 100 USDC left": what open trades have not reserved or used up. */
export function leftLabel(l: Pick<Listing, "remainingAmount" | "maxAmount" | "asset">): string {
  return `${trimAmount(l.remainingAmount)} of ${trimAmount(l.maxAmount)} ${l.asset} left`;
}

/** Less than the minimum is left: the map hides the listing and `trade.open` refuses it. */
export function belowMinimum(l: Pick<Listing, "remainingAmount" | "minAmount">): boolean {
  return toStroops(l.remainingAmount) < toStroops(l.minAmount);
}

export function rateLabel(l: Pick<Listing, "rate" | "fiatCode" | "asset">): string {
  return `${trimAmount(l.rate)} ${l.fiatCode} / ${l.asset}`;
}

export function countryName(cc: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc;
  } catch {
    return cc;
  }
}
