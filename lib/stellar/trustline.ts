// A USDC claimant without a trustline fails the claim with op_no_trust (SOW
// D1), so the buyer adds this before the seller can lock USDC.

import { BASE_FEE, Operation, TransactionBuilder, type Account, type Transaction } from "@stellar/stellar-sdk";

import { toAsset } from "./assets";
import { NETWORK_PASSPHRASE } from "./settlement";

/** Unsigned changeTrust tx adding the testnet USDC trustline to `account`. */
export function buildUsdcTrustlineTransaction(account: Account): Transaction {
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.changeTrust({ asset: toAsset("USDC") }))
    .setTimeout(300)
    .build();
}
