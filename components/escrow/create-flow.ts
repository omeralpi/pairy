// The parts of the seller's escrow creation (D2 §7.1) that need no screen:
// the steps it shows, when it must not start another creation, and the
// browser's own check of Trustless Work's deploy before the one-time key
// signs it (DECISIONS 7).

import { EscrowNotFoundError, readEscrow } from "@/lib/escrow/read";
import { expectedTerms } from "@/lib/escrow/terms";
import { decodeEscrowCall, describeEscrowCall, validateEscrowCall } from "@/lib/escrow/xdr";
import { fromStroops } from "@/lib/trade/amount";

/** The creation, step by step, as the panel lists it. */
export const CREATE_STEPS = [
  { id: "key", label: "Make a one-time key in this browser" },
  { id: "friendbot", label: "Open its testnet account with Friendbot's free test XLM" },
  { id: "prepare", label: "Get the unsigned escrow creation from Trustless Work, through Pairy" },
  { id: "check", label: "Check it in this browser: roles, amount, arbiter and fee" },
  { id: "sign", label: "Sign it with the one-time key" },
  { id: "submit", label: "Send it to Stellar testnet" },
  { id: "record", label: "Pairy reads it back from the chain and records the escrow" },
] as const;

export type CreateStep = (typeof CREATE_STEPS)[number]["id"];

const order = (s: CreateStep) => CREATE_STEPS.findIndex((x) => x.id === s);

/** A step before `at` is done; `at` itself is running, or failed; the rest are not reached. */
export function stepStatus(step: CreateStep, at: CreateStep | null, failed: boolean): "done" | "now" | "failed" | "todo" {
  if (at === null) return "todo";
  const i = order(step);
  const j = order(at);
  return i < j ? "done" : i > j ? "todo" : failed ? "failed" : "now";
}

/**
 * Trustless Work's deploy, checked against this trade's own terms and the key
 * this browser made, as the server checked it before returning it. [] means
 * the one-time key may sign it. `summary` and `fee` say what it signs.
 */
export function checkCreation(
  prepared: { unsignedXdr: string; txHash: string; contractId: string },
  trade: { seller: string; buyer: string; amount: string },
  admin: string,
  now = new Date(),
): { problems: string[]; summary: string; fee: string } {
  let decoded;
  try {
    decoded = decodeEscrowCall(prepared);
  } catch (e) {
    return { problems: [`It could not be read as a transaction (${e instanceof Error ? e.message : String(e)}).`], summary: "", fee: "" };
  }
  const terms = expectedTerms({ buyer: trade.buyer, seller: trade.seller, amount: trade.amount, escrowAdmin: admin });
  return {
    problems: validateEscrowCall(decoded, { kind: "deploy", admin, contractId: prepared.contractId, terms }, now),
    summary: describeEscrowCall(decoded),
    fee: fromStroops(decoded.fee),
  };
}

/**
 * Why the seller must not start a creation now, or null. A creation from
 * this browser that landed but is not recorded (`unreported`), or whose hash
 * this browser still holds, must be recorded, not repeated.
 */
export function creationBlocked(o: {
  unreported: string | null;
  pending: { kind: string } | null;
  preflight: { loading: boolean; error: string | null; blockedReason: string | null };
}): string | null {
  if (o.unreported) return "The escrow creation is on Stellar testnet but not recorded yet. Use Retry recording below; don't create another.";
  if (o.pending?.kind === "create") {
    return "You already sent an escrow creation for this trade from this browser. Don't create another: this page is recording it.";
  }
  if (o.preflight.loading) return "Checking both accounts on Stellar testnet…";
  if (o.preflight.error) return o.preflight.error;
  if (o.preflight.blockedReason) return "Sort out the item above, then create the escrow.";
  return null;
}

/**
 * Soroban RPC may show the new escrow a ledger after Horizon accepted the
 * deploy, and Pairy reads it from there before recording it. Waits until it
 * does, at most `tries` reads; on any other error the record says what is wrong.
 */
export async function escrowVisible(contractId: string, read = readEscrow, tries = 20, delayMs = 1000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      await read(contractId);
      return;
    } catch (e) {
      if (!(e instanceof EscrowNotFoundError)) return;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
}
