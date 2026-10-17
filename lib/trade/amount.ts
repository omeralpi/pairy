// Exact decimal arithmetic for Stellar amounts (7 places) and listing rates
// (4 places). Floats would let bound checks and fiat totals drift.

import { z } from "zod";

/** The largest amount a Stellar operation accepts: int64 stroops (922337203685.4775807). */
export const MAX_STROOPS = 9_223_372_036_854_775_807n;

const AMOUNT = /^\d{1,13}(\.\d{1,7})?$/;

/** A Stellar amount as typed by a user: at most 7 decimals, > 0, within int64 stroops. */
export const amountInput = z
  .string()
  .trim()
  .regex(AMOUNT, "Amount must be a number with at most 7 decimals")
  // zod runs refinements even when the regex failed; BigInt() would throw on those.
  .refine((v) => !AMOUNT.test(v) || toStroops(v) > 0n, "Amount must be greater than zero")
  .refine((v) => !AMOUNT.test(v) || toStroops(v) <= MAX_STROOPS, "Amount is larger than a Stellar transaction can carry");

export function toUnits(v: string, scale: number): bigint {
  const [int, frac = ""] = v.split(".");
  return BigInt(int + frac.slice(0, scale).padEnd(scale, "0"));
}

/** Non-negative units → fixed-point decimal string. */
export function fromUnits(units: bigint, scale: number): string {
  const s = units.toString().padStart(scale + 1, "0");
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

export function toStroops(v: string): bigint {
  return toUnits(v, 7);
}

export function fromStroops(stroops: bigint): string {
  return trimAmount(fromUnits(stroops, 7));
}

/** amount × rate, rounded half-up to cents. */
export function fiatTotal(amount: string, rate: string): string {
  const exact = toUnits(amount, 7) * toUnits(rate, 4); // 11 decimal places
  return fromUnits((exact + 5n * 10n ** 8n) / 10n ** 9n, 2);
}

/** "25.5000000" → "25.5", "10.0000000" → "10". */
export function trimAmount(v: string): string {
  return v.includes(".") ? v.replace(/\.?0+$/, "") : v;
}
