// Turns Horizon submission failures into sentences a trader can act on.

import { TransactionFailedError } from "@stellar/stellar-sdk";

const MESSAGES: Record<string, string> = {
  op_no_trust:
    "The receiving account has no USDC trustline, so the network refused it. Add the USDC trustline first, then try again.",
  op_cannot_claim:
    "This account cannot claim the balance right now. The buyer can claim only inside the window; the seller only after it closes.",
  op_does_not_exist: "This locked balance no longer exists on the ledger. It may already have been claimed.",
  op_underfunded: "The account does not hold enough of this asset for the transaction.",
  op_low_reserve: "The account would fall below its minimum XLM balance. Add XLM and try again.",
  op_line_full: "The receiving USDC trustline's limit is too low for this amount.",
  op_not_authorized: "The USDC issuer has not authorized this account's trustline.",
  tx_bad_seq: "The account's sequence number changed before submission. Try again.",
  tx_too_late:
    "The signed transaction expired before it reached the network, so nothing was charged. Try again if the claim window is still open.",
  tx_insufficient_balance: "The account cannot pay the network fee.",
  tx_insufficient_fee: "The network is busy and the fee was too low. Try again.",
  tx_bad_auth: "The transaction was not signed by the account it came from.",
  tx_no_source_account: "The account does not exist on testnet yet.",
};

export function describeStellarError(e: unknown): string {
  if (e instanceof TransactionFailedError) {
    const { transaction, operations } = e.getResultCodes();
    const codes = [...operations.filter((c) => c !== "op_success"), transaction];
    const known = codes.find((c) => MESSAGES[c]);
    return known ? `${MESSAGES[known]} (${known})` : `Stellar rejected the transaction (${codes.join(", ")}).`;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}
