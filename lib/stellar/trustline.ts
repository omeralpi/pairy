// STUB — replaced by the wallet agent. Signature is the contract the trade UI
// relies on; keep it.

import type { Account, Transaction } from "@stellar/stellar-sdk";

/** Unsigned changeTrust tx adding the testnet USDC trustline to `account`. */
export function buildUsdcTrustlineTransaction(_account: Account): Transaction {
  throw new Error("buildUsdcTrustlineTransaction not implemented");
}
