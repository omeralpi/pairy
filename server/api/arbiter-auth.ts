// The arbiter account's signers, read from Horizon, never from a list in the
// code: the list is meant to grow (3-of-5, then a council) without a deploy.
// A signer key may not be a party to a protected trade (PLAN I13); WP-29
// builds arbiterProcedure on the same state. Everything here fails closed:
// when Horizon cannot be read it throws, and callers refuse.

import { ARBITER_ACCOUNT } from "@/lib/escrow/config";
import { horizon } from "@/lib/stellar/horizon";

export type ArbiterAccountState = {
  /** Keys that count toward a threshold (weight 1 or more), the account's own key left out. */
  signers: { key: string; weight: number }[];
  /** The account's own key: 0 once setup-arbiter.ts switched it off. */
  masterWeight: number;
  thresholds: { low: number; med: number; high: number };
};

const CACHE_MS = 60_000;
let cached: { at: number; state: ArbiterAccountState } | null = null;

/** The arbiter account as Horizon shows it, at most a minute old. Throws when Horizon can't be read. */
export async function arbiterAccountState(): Promise<ArbiterAccountState> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.state;
  const account = await horizon.loadAccount(ARBITER_ACCOUNT);
  const { low_threshold: low, med_threshold: med, high_threshold: high } = account.thresholds;
  const state: ArbiterAccountState = {
    // Horizon lists the account's own key among its signers, and a removed signer at weight 0.
    signers: account.signers.filter((s) => s.key !== ARBITER_ACCOUNT && s.weight > 0).map((s) => ({ key: s.key, weight: s.weight })),
    masterWeight: account.signers.find((s) => s.key === ARBITER_ACCOUNT)?.weight ?? 0,
    thresholds: { low, med, high },
  };
  cached = { at: Date.now(), state };
  return state;
}

/** Whether `publicKey` can sign for the arbiter account now. Rejects when Horizon can't be read. */
export async function isArbiterSigner(publicKey: string): Promise<boolean> {
  return (await arbiterAccountState()).signers.some((s) => s.key === publicKey);
}

/**
 * O-17's preflight of the arbiter account, in words; [] = it passes. Its own
 * key at weight 0, every threshold at least 2, no signer able to meet a
 * threshold alone, and at least two signers.
 */
export function arbiterAccountProblems(s: ArbiterAccountState): string[] {
  const { low, med, high } = s.thresholds;
  const lowest = Math.min(low, med, high);
  return [
    s.masterWeight !== 0 ? `its own key has weight ${s.masterWeight}` : "",
    lowest < 2 ? `its thresholds are ${low}/${med}/${high}` : "",
    s.signers.some((x) => x.weight >= lowest) ? "one signer alone meets a threshold" : "",
    s.signers.length < 2 ? `it has ${s.signers.length} signer${s.signers.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
}
