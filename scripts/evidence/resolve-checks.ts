// Two checks of escrow-exits.ts's resolve that need no network, kept apart so
// they can be tested on the recorded fixtures (escrow-exits.ts runs main()
// when it is imported).

import { RESOLVE_WINDOW_SECONDS } from "../../lib/escrow/config";
import { extractSignatures, type ArbiterSignature } from "../../lib/escrow/multisig";

/**
 * O-17's rent rule. The contract extends the ["Escrow"] entry only once fewer
 * than 17,280 ledgers are left; if that point falls inside the window, the
 * resolve would pay rent its simulation did not price. Ledgers close about
 * every 5 s. Without a TTL to check, it refuses.
 */
export function rentProblem(liveUntilLedger: number | null, latestLedgerSeq: number): string | null {
  if (liveUntilLedger === null) return "Soroban RPC gave no storage TTL for the escrow, so the rent rule cannot be checked; prepare again later.";
  const left = liveUntilLedger - latestLedgerSeq;
  const band = Math.ceil(RESOLVE_WINDOW_SECONDS / 5) + 60;
  if (left < 17_280 || left >= 17_280 + band) return null;
  return `The escrow's storage rent falls due in about ${Math.ceil(((left - 17_280) * 5) / 60)} minutes; prepare after that.`;
}

/**
 * A signed copy saved in .state/: the arbiter signatures it carries on the
 * re-timed resolve, or why it is ignored. A copy with no signature at all (the
 * unsigned resolve saved by mistake) is ignored too, with a word to say so.
 */
export function readSignedCopy(text: string, txHash: string, signers: string[]): { signatures: ArbiterSignature[]; problem: string | null } {
  try {
    const signatures = extractSignatures(text, txHash, signers);
    return { signatures, problem: signatures.length ? null : "no signature by an arbiter signer; is this the signed copy?" };
  } catch (e) {
    return { signatures: [], problem: `${e instanceof Error ? e.message : String(e)} Ignored; save a new copy to try again.` };
  }
}
