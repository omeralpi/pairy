// A claimant of an issued asset without a trustline fails the claim with
// op_no_trust (SOW D1), so the buyer adds this before the seller can lock it.

import { BASE_FEE, Operation, TransactionBuilder, type Account, type Transaction } from "@stellar/stellar-sdk";

import { toAsset, type AssetCode } from "./assets";
import { NETWORK_PASSPHRASE } from "./settlement";

/**
 * Unsigned changeTrust tx adding the trustline for `code` to `account`.
 * `notAfter` (unix seconds, on the network's clock) becomes its maxTime;
 * without it, 300 s from this device's now.
 */
export function buildTrustlineTransaction(account: Account, code: AssetCode, notAfter?: number): Transaction {
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
    ...(notAfter === undefined ? {} : { timebounds: { minTime: 0, maxTime: notAfter } }),
  }).addOperation(Operation.changeTrust({ asset: toAsset(code) }));
  return (notAfter === undefined ? builder.setTimeout(300) : builder).build();
}
