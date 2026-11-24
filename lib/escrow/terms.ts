// What a protected trade's escrow must say, and the one check of what it does
// say. It runs on the escrow as read from the chain (lib/escrow/read.ts) before
// anyone funds it, and on the escrow a transaction carries (lib/escrow/xdr.ts:
// the deploy's init argument, fund's expected_escrow). Pure, so the browser
// and the server run the same code.

import { fromStroops, toStroops } from "@/lib/trade/amount";

import { ARBITER_ACCOUNT, MILESTONE_DESCRIPTION, PLATFORM_ACCOUNT, SERVICE_PROVIDER_ROLE, USDC_SAC } from "./config";

/** What an escrow promises: who may do what, for how much, in which token. */
export type EscrowTerms = {
  admin: string;
  platform: string;
  receiver: string;
  approvers: string[];
  releaseSigners: string[];
  disputeResolvers: string[];
  serviceProviders: string[];
  amountStroops: bigint;
  platformFeePercent: number;
  tokenContract: string;
  milestones: { description: string }[];
};

/**
 * Where the escrow stands on chain. `disputed` is an open dispute (false again
 * once resolved). balanceStroops is the escrow's USDC in the USDC contract,
 * never its stored amount: a resolution must pay out exactly that (FIXES X-07).
 */
export type EscrowStatus = { disputed: boolean; released: boolean; resolved: boolean; balanceStroops: bigint };

/**
 * The terms Pairy asks Trustless Work for (D2 §2). `resolver` is only for the
 * evidence scripts' test 2-of-2 or the SOW's fallback resolver; a trade always
 * names ARBITER_ACCOUNT.
 */
export function expectedTerms(
  t: { buyer: string; seller: string; amount: string; escrowAdmin: string },
  opts?: { resolver?: string },
): EscrowTerms {
  return {
    admin: t.escrowAdmin,
    platform: PLATFORM_ACCOUNT,
    receiver: t.buyer,
    approvers: [t.seller],
    releaseSigners: [t.seller],
    disputeResolvers: [opts?.resolver ?? ARBITER_ACCOUNT],
    serviceProviders: [SERVICE_PROVIDER_ROLE === "seller" ? t.seller : t.buyer],
    amountStroops: toStroops(t.amount),
    platformFeePercent: 0,
    tokenContract: USDC_SAC,
    milestones: [{ description: MILESTONE_DESCRIPTION }],
  };
}

/** `wasm` and `contract` are for callers that check the escrow's code and address next to its terms. */
export type TermProblem = { field: keyof EscrowTerms | "wasm" | "contract"; expected: string; found: string; message: string };

/** Display order: the SOW's four roles first, then the rest (TermCheckList shows them in this order). */
const LABEL: Record<keyof EscrowTerms, string> = {
  receiver: "receiver",
  approvers: "approvers",
  releaseSigners: "release signers",
  disputeResolvers: "dispute resolvers",
  platformFeePercent: "platform fee",
  platform: "platform",
  admin: "admin",
  serviceProviders: "service providers",
  amountStroops: "amount",
  tokenContract: "token",
  milestones: "milestones",
};

/** A stable text form of decoded values, for exact comparison (bigints included). */
const canon = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));

function show(v: unknown): string {
  if (typeof v === "bigint") return `${fromStroops(v)} USDC`;
  if (Array.isArray(v)) return v.length ? v.map((x: unknown) => (x !== null && typeof x === "object" ? show(Object.values(x)[0]) : show(x))).join(", ") : "none";
  if (v !== null && typeof v === "object") return "a structure";
  return v === undefined ? "missing" : String(v);
}

/** [] = every check passed. One problem per field that differs, in display order. */
export function checkEscrowTerms(found: EscrowTerms, expected: EscrowTerms): TermProblem[] {
  return (Object.keys(LABEL) as (keyof EscrowTerms)[])
    .filter((k) => canon(found[k]) !== canon(expected[k]))
    .map((k) => {
      const [f, e] = [show(found[k]), show(expected[k])];
      return { field: k, expected: e, found: f, message: `The escrow's ${LABEL[k]} ${Array.isArray(expected[k]) ? "are" : "is"} ${f}, not ${e}.` };
    });
}

/**
 * The terms in the contract's own escrow struct, as scValToNative decodes it
 * (snake_case roles, the amount as a bigint). A field the struct lacks stays
 * undefined, so checkEscrowTerms reports it as missing.
 */
export function termsOfEscrow(struct: unknown): EscrowTerms {
  // The contract's struct, decoded; every field read here is compared by checkEscrowTerms.
  const s: any = struct ?? {};
  const roles = s.roles ?? {};
  return {
    admin: roles.admin,
    platform: roles.platform,
    receiver: roles.receiver,
    approvers: roles.approvers,
    releaseSigners: roles.release_signers,
    disputeResolvers: roles.dispute_resolvers,
    serviceProviders: roles.service_providers,
    amountStroops: s.amount,
    platformFeePercent: s.platform_fee,
    tokenContract: s.trustline?.address,
    milestones: Array.isArray(s.milestones) ? s.milestones.map((m: { description?: unknown }) => ({ description: m?.description })) : s.milestones,
  };
}
