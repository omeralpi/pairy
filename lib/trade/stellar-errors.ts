// Turns Horizon submission failures into sentences a trader can act on.

import { TransactionFailedError } from "@stellar/stellar-sdk";

import { ASSETS, type AssetCode } from "@/lib/stellar/assets";

/** The trustline messages name the asset when the caller knows it, else "this asset". */
function messages(asset?: AssetCode): Record<string, string> {
  const name = asset && ASSETS[asset].label;
  return {
    op_no_trust: name
      ? `The receiving account has no ${name} trustline, so the network refused it. Add the ${name} trustline first, then try again.`
      : "The receiving account has no trustline for this asset, so the network refused it. Add the trustline first, then try again.",
    op_cannot_claim:
      "This account cannot claim the balance right now. The buyer can claim only inside the window; the seller only after it closes.",
    op_does_not_exist: "This locked balance no longer exists on the ledger. It may already have been claimed.",
    op_underfunded: "The account does not hold enough of this asset for the transaction.",
    op_low_reserve: "The account would fall below its minimum XLM balance. Add XLM and try again.",
    op_line_full: name
      ? `The receiving ${name} trustline's limit is too low for this amount.`
      : "The receiving trustline for this asset has a limit too low for this amount.",
    op_not_authorized: name
      ? `The ${name} issuer has not authorized this account's trustline.`
      : "This asset's issuer has not authorized this account's trustline.",
    tx_bad_seq: "The account's sequence number changed before submission. Try again.",
    tx_too_late:
      "The signed transaction expired before it reached the network, so nothing was charged. Try again if the claim window is still open.",
    tx_insufficient_balance: "The account cannot pay the network fee.",
    tx_insufficient_fee: "The network is busy and the fee was too low. Try again.",
    tx_bad_auth: "The transaction was not signed by the account it came from.",
    tx_no_source_account: "The account does not exist on testnet yet.",
  };
}

export function describeStellarError(e: unknown, asset?: AssetCode): string {
  if (e instanceof TransactionFailedError) {
    const MESSAGES = messages(asset);
    const { transaction, operations } = e.getResultCodes();
    const codes = [...operations.filter((c) => c !== "op_success"), transaction];
    const known = codes.find((c) => MESSAGES[c]);
    return known ? `${MESSAGES[known]} (${known})` : `Stellar rejected the transaction (${codes.join(", ")}).`;
  }
  return e instanceof Error ? e.message : "Something went wrong.";
}
