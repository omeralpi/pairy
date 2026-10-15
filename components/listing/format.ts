import type { RouterOutputs } from "@/lib/api";

export type Listing = RouterOutputs["listing"]["list"][number];

/** From the owner's side: a sell_crypto owner is selling crypto for cash. */
export function sideLabel(side: Listing["side"]): string {
  return side === "sell_crypto" ? "Selling" : "Buying";
}

export function shortAddress(publicKey: string): string {
  return `${publicKey.slice(0, 4)}…${publicKey.slice(-4)}`;
}

/** Drop the trailing zeros numeric(20, 7) pads with. */
export function trimAmount(v: string): string {
  return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
}

export function amountRange(l: Pick<Listing, "minAmount" | "maxAmount" | "asset">): string {
  const min = trimAmount(l.minAmount);
  const max = trimAmount(l.maxAmount);
  return min === max ? `${min} ${l.asset}` : `${min}–${max} ${l.asset}`;
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
