// The parts of the seller's fund and release, and of either trader's dispute
// (D2 §7.1, §7.3), that need no screen: the escrow's terms row by row as
// this browser read them from Soroban RPC (TermCheckList), the browser's own
// check of Trustless Work's transaction before the wallet signs it
// (DECISIONS 7), and when the button must stay off.

import { shortAddress } from "@/components/listing/format";
import { TW_ESCROW_WASM_HASH } from "@/lib/escrow/config";
import { readEscrow, readWasmHash } from "@/lib/escrow/read";
import { checkEscrowTerms, type EscrowStatus, type EscrowTerms } from "@/lib/escrow/terms";
import { decodeEscrowCall, describeEscrowCall, validateEscrowCall, type CallExpectation } from "@/lib/escrow/xdr";
import { fromStroops } from "@/lib/trade/amount";

/** The escrow as the chain has it now, and the code it runs. */
export type EscrowRead = { terms: EscrowTerms; status: EscrowStatus; wasmHash: string };

/** Straight from Soroban RPC (lib/escrow/read.ts), never through Pairy's server or Trustless Work (SOW). */
export async function readEscrowOnChain(contractId: string): Promise<EscrowRead> {
  const [{ terms, status }, wasmHash] = await Promise.all([readEscrow(contractId), readWasmHash(contractId)]);
  return { terms, status, wasmHash };
}

export type TermRow = { id: keyof EscrowTerms | "wasm" | "empty"; label: string; value: string; problem: string | null };

/**
 * Each term as the seller reads it when it holds. The key order is
 * checkEscrowTerms' display order: the SOW's four roles first, then the rest.
 */
const TERMS: Record<keyof EscrowTerms, { label: string; value: (e: EscrowTerms) => string }> = {
  receiver: { label: "Receiver", value: (e) => `the buyer, ${shortAddress(e.receiver)}` },
  approvers: { label: "Approver", value: () => "you" },
  releaseSigners: { label: "Release signer", value: () => "you" },
  disputeResolvers: { label: "Dispute resolver", value: (e) => `the arbiter account, ${e.disputeResolvers.map(shortAddress).join(", ")}` },
  platformFeePercent: { label: "Platform fee", value: (e) => `${e.platformFeePercent}%` },
  platform: { label: "Platform", value: (e) => `Pairy's platform account, which can't sign, ${shortAddress(e.platform)}` },
  admin: { label: "Admin", value: (e) => `the one-time key that created it, ${shortAddress(e.admin)}` },
  serviceProviders: { label: "Service provider", value: (e) => (e.serviceProviders[0] === e.receiver ? "the buyer" : "you") },
  otherRoles: { label: "Other roles", value: () => "none" },
  amountStroops: { label: "Amount", value: (e) => `${fromStroops(e.amountStroops)} USDC` },
  tokenContract: { label: "Token", value: (e) => `USDC, ${shortAddress(e.tokenContract)}` },
  milestones: { label: "Milestone", value: (e) => e.milestones.map((m) => m.description).join(", ") },
};

/**
 * The TermCheckList: every term of the escrow as read, against this trade's
 * own (expectedTerms), then the code it runs and whether it is still empty
 * and open. A row's problem is the check's own sentence; null is ✓.
 */
export function termRows(read: EscrowRead, expected: EscrowTerms): TermRow[] {
  const problems = checkEscrowTerms(read.terms, expected);
  const rows: TermRow[] = (Object.keys(TERMS) as (keyof EscrowTerms)[]).map((id) => ({
    id,
    label: TERMS[id].label,
    value: TERMS[id].value(expected),
    problem: problems.find((p) => p.field === id)?.message ?? null,
  }));
  // Fail closed: after a testnet reset nothing is pinned until WP-46 pins it again.
  const code = read.wasmHash === TW_ESCROW_WASM_HASH ? null : `It runs contract code ${read.wasmHash}, not Trustless Work's escrow as Pairy pinned it.`;
  const s = read.status;
  const used = [
    s.balanceStroops !== 0n && `It already holds ${fromStroops(s.balanceStroops)} USDC.`,
    s.released && "It is already released.",
    (s.disputed || s.resolved) && "It is already in a dispute.",
  ].filter((x): x is string => !!x);
  rows.push(
    { id: "wasm", label: "Code", value: "Trustless Work's escrow", problem: code },
    { id: "empty", label: "Holds", value: "nothing yet", problem: used.length ? used.join(" ") : null },
  );
  return rows;
}

/**
 * Trustless Work's transaction, checked in this browser against this trade
 * before the wallet opens, as the server checked it before returning it.
 * [] means the wallet may sign it; `summary` is the signing dialog's line
 * and `fee` the most the network can charge, in XLM.
 */
export function checkPrepared(
  prepared: { unsignedXdr: string; txHash: string },
  expectation: CallExpectation,
  now = new Date(),
): { problems: string[]; summary: string; fee: string } {
  let decoded;
  try {
    decoded = decodeEscrowCall(prepared);
  } catch (e) {
    return { problems: [`It could not be read as a transaction (${e instanceof Error ? e.message : String(e)}).`], summary: "", fee: "" };
  }
  return { problems: validateEscrowCall(decoded, expectation, now), summary: describeEscrowCall(decoded), fee: fromStroops(decoded.fee) };
}

/** D2 §7.3's loading and Soroban RPC failure lines; the panel shows them where the terms go. */
export const READING = "Reading the escrow from Stellar testnet…";
export const UNREADABLE = "Could not read the escrow; try again.";

/**
 * Why the seller must not fund now, or null. In order: a fund from this
 * browser that must be recorded, not repeated; the escrow being read; any ✗;
 * the server's checks; the acknowledgement; the wallet (`wallet`, from
 * walletProblem).
 */
export function fundBlocked(o: {
  unreported: string | null;
  pending: { kind: string } | null;
  read: { loading: boolean; failed: boolean; rows: TermRow[] | undefined };
  preflight: { loading: boolean; error: string | null; blockedReason: string | null };
  acknowledged: boolean;
  wallet: string | null;
}): string | null {
  if (o.unreported) return "The fund is on Stellar testnet but not recorded yet. Use Retry recording below; don't fund it again.";
  if (o.pending?.kind === "fund") return "You already sent the fund for this escrow from this browser. Don't fund it again: this page is recording it.";
  if (o.read.loading) return READING;
  if (o.read.failed || !o.read.rows) return UNREADABLE;
  const problems = o.read.rows.flatMap((r) => (r.problem ? [r.problem] : []));
  if (problems.length) return `Don't fund this escrow: ${problems.join(" ")}`;
  if (o.preflight.loading) return "Checking your account on Stellar testnet…";
  if (o.preflight.error) return o.preflight.error;
  if (o.preflight.blockedReason) return o.preflight.blockedReason;
  if (!o.acknowledged) return "Tick the box above to continue.";
  return o.wallet;
}

/** Why the seller must not release now, or null: a release from this browser must be recorded, not repeated. */
export function releaseBlocked(o: { unreported: string | null; pending: { kind: string } | null; wallet: string | null }): string | null {
  if (o.unreported) return "The release is on Stellar testnet but not recorded yet. Use Retry recording below; don't release it again.";
  if (o.pending?.kind === "release") return "You already sent the release from this browser. Don't release it again: this page is recording it.";
  return o.wallet;
}

/** Why this trader must not dispute now, or null: a dispute from this browser must be recorded, not repeated. */
export function disputeBlocked(o: { unreported: string | null; pending: { kind: string } | null; wallet: string | null }): string | null {
  if (o.unreported) return "The dispute is on Stellar testnet but not recorded yet. Use Retry recording below; don't send it again.";
  if (o.pending?.kind === "dispute") return "You already sent a dispute from this browser. Don't send it again: this page is recording it.";
  return o.wallet;
}
