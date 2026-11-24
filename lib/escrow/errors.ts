// Trustless Work's refusals as sentences a trader can act on. Its errors are
// RFC 7807 problem documents with a `code`; the codes here are the ones it
// gave on testnet (tests/fixtures/tw/errors.json, WP-03) plus the release trap
// its OpenAPI documents. Any other code shows Trustless Work's own detail.
// Shared code: it takes the problem's fields, not server/tw's error class.

/** The parts of a Trustless Work refusal this reads (TwApiError has all three). */
export type EscrowProblem = { status?: number; code?: string; detail?: string };

const SENTENCES: Record<string, string> = {
  // Pairy's key is missing or wrong: nothing the trader can fix.
  AUTH_CREDENTIAL_MISSING: "Protected trades are not configured on this server. Nothing was signed.",
  ESCROW_SIGNER_MUST_BE_APPROVER_AND_RELEASE_SIGNER: "Only the seller can release this escrow.",
  ESCROW_NOT_COMPLETED: "The escrow's milestone is not approved, so it cannot be released yet.",
  ESCROW_DISPUTE_RESOLVER_CANNOT_DISPUTE: "The arbiter cannot open a dispute.",
  ESCROW_NOT_IN_DISPUTE: "This escrow is not in a dispute.",
  ESCROW_DISTRIBUTIONS_MUST_EQUAL_BALANCE:
    "The payout must be the escrow's whole balance. Prepare the resolution again; the balance may have changed.",
  // Trustless Work's indexer has not seen a new escrow yet.
  ESCROW_NOT_FOUND: "Trustless Work does not know this escrow yet. Try again in a minute.",
};

export function describeEscrowError(p: EscrowProblem): string {
  if (p.code && SENTENCES[p.code]) return SENTENCES[p.code];
  // Pairy builds every request itself, so a bad request is Pairy's to fix; the detail says which field.
  if (p.code === "BAD_REQUEST") return `Trustless Work refused Pairy's request (${p.detail ?? "no detail"}). Nothing was signed.`;
  if (p.detail) return `Trustless Work refused: ${p.detail}`;
  return `Trustless Work refused the request (HTTP ${p.status ?? "unknown"}). Nothing was signed.`;
}
