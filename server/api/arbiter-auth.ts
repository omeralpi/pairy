// The arbiter account's signers, read from Horizon, never from a list in the
// code: the list is meant to grow (3-of-5, then a council) without a deploy.
// A signer key may not be a party to a protected trade (PLAN I13), and only a
// signer may use the arbiter's procedures (arbiterProcedure). Everything here
// fails closed: when Horizon cannot be read it throws, and callers refuse.

import { TRPCError } from "@trpc/server";

import { ARBITER_ACCOUNT } from "@/lib/escrow/config";
import { horizon } from "@/lib/stellar/horizon";
import { protectedProcedure } from "@/server/api/trpc";

export type ArbiterAccountState = {
  /** Keys that count toward a threshold (weight 1 or more), the account's own key left out. */
  signers: { key: string; weight: number }[];
  /** The account's own key: 0 once setup-arbiter.ts switched it off. */
  masterWeight: number;
  thresholds: { low: number; med: number; high: number };
};

const CACHE_MS = 60_000;
let cached: { at: number; state: ArbiterAccountState } | null = null;

/** Reads the arbiter account from Horizon and caches what it read. Throws when Horizon can't be read. */
async function load(): Promise<{ state: ArbiterAccountState; sequence: string }> {
  const account = await horizon.loadAccount(ARBITER_ACCOUNT);
  const { low_threshold: low, med_threshold: med, high_threshold: high } = account.thresholds;
  const state: ArbiterAccountState = {
    // Horizon lists the account's own key among its signers, and a removed signer at weight 0.
    signers: account.signers.filter((s) => s.key !== ARBITER_ACCOUNT && s.weight > 0).map((s) => ({ key: s.key, weight: s.weight })),
    masterWeight: account.signers.find((s) => s.key === ARBITER_ACCOUNT)?.weight ?? 0,
    thresholds: { low, med, high },
  };
  cached = { at: Date.now(), state };
  return { state, sequence: account.sequence };
}

/** The arbiter account as Horizon shows it, at most a minute old. Throws when Horizon can't be read. */
export async function arbiterAccountState(): Promise<ArbiterAccountState> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.state;
  return (await load()).state;
}

/**
 * The arbiter account as Horizon shows it now, never cached, with its
 * sequence number: a prepared resolution can land only on the next one
 * (FIXES F-03). Throws when Horizon can't be read.
 */
export async function arbiterAccountNow(): Promise<ArbiterAccountState & { sequence: string }> {
  const { state, sequence } = await load();
  return { ...state, sequence };
}

/** Whether `publicKey` can sign for the arbiter account now. Rejects when Horizon can't be read. */
export async function isArbiterSigner(publicKey: string): Promise<boolean> {
  return (await arbiterAccountState()).signers.some((s) => s.key === publicKey);
}

/** The arbiter's procedures: signed in (SEP-53) with a key that signs for the arbiter account now. */
export const arbiterProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  let signer: boolean;
  try {
    signer = await isArbiterSigner(ctx.session.publicKey);
  } catch (e) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Couldn't confirm the signer list. Try again.", cause: e });
  }
  if (!signer) throw new TRPCError({ code: "FORBIDDEN", message: "This page is only for the arbiter account's signers." });
  return next();
});

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
