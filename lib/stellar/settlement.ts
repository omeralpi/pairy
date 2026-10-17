// CAP-23 two-party settlement for a Pairy trade.
//
// This module is the entire settlement surface, and it is deliberately only
// stock @stellar/stellar-sdk calls:
//
//   Claimant.predicateBeforeRelativeTime · Claimant.predicateNot
//   Operation.createClaimableBalance     · Operation.claimClaimableBalance
//
// No predicate logic, no predicate evaluation, no balance-ID derivation, no
// signing and no contract. The chain enforces the predicates; the wallet
// (Freighter or the device key) signs; Horizon reports the result.
//
// The lock has exactly two claimants and no third role:
//   buyer:  BEFORE_RELATIVE_TIME(window)        claims at the meeting
//   seller: NOT(BEFORE_RELATIVE_TIME(window))   reclaims once the window closes

import {
  Asset,
  Claimant,
  Networks,
  Operation,
  TransactionBuilder,
  type Account,
  type Transaction,
} from "@stellar/stellar-sdk";

/** 72 hours. The production claim window. */
export const CLAIM_WINDOW_SECONDS = 259_200;

export const NETWORK_PASSPHRASE = Networks.TESTNET;

/**
 * The most a lock, claim or reclaim may pay in fees, in stroops. The network
 * charges what the ledger needs (the 100-stroop base fee when it is quiet), so
 * this only matters in a fee surge, where a base-fee bid would be shut out
 * while the buyer's claim window runs.
 */
export const SETTLEMENT_FEE_BID = "10000";

/** How long a built transaction stays valid for signing + submission. */
const TX_TIMEOUT_SECONDS = 300;

export type LockParams = {
  asset: Asset;
  /** Decimal string, up to 7 places, e.g. "25.5". */
  amount: string;
  buyer: string;
  seller: string;
  /** Defaults to CLAIM_WINDOW_SECONDS. Integration tests pass 60. */
  windowSeconds?: number;
};

export function lockClaimants(
  buyer: string,
  seller: string,
  windowSeconds: number = CLAIM_WINDOW_SECONDS,
): Claimant[] {
  const window = Claimant.predicateBeforeRelativeTime(String(windowSeconds));
  return [
    new Claimant(buyer, window),
    new Claimant(seller, Claimant.predicateNot(window)),
  ];
}

export function lockOperation(params: LockParams) {
  return Operation.createClaimableBalance({
    asset: params.asset,
    amount: params.amount,
    claimants: lockClaimants(
      params.buyer,
      params.seller,
      params.windowSeconds,
    ),
  });
}

/** The same operation serves the buyer's claim and the seller's reclaim. */
export function claimOperation(balanceId: string) {
  return Operation.claimClaimableBalance({ balanceId });
}

/**
 * Unsigned lock transaction, sourced from the seller's account. `notAfter`
 * (unix seconds, on the network's clock) becomes its maxTime, so a device
 * clock running slow cannot expire it before it is sent; without it, the
 * usual 300 s timeout from this device's now applies.
 */
export function buildLockTransaction(
  sellerAccount: Account,
  params: Omit<LockParams, "seller">,
  notAfter?: number,
): Transaction {
  const builder = new TransactionBuilder(sellerAccount, {
    fee: SETTLEMENT_FEE_BID,
    networkPassphrase: NETWORK_PASSPHRASE,
    ...(notAfter === undefined ? {} : { timebounds: { minTime: 0, maxTime: notAfter } }),
  }).addOperation(
    lockOperation({ ...params, seller: sellerAccount.accountId() }),
  );
  return (notAfter === undefined ? builder.setTimeout(TX_TIMEOUT_SECONDS) : builder).build();
}

/**
 * Unsigned claim (buyer) or reclaim (seller) transaction. `notAfter` (unix
 * seconds, on the network's clock) becomes the transaction's maxTime as is,
 * so this device's clock plays no part: a claim that reaches the network
 * later is refused as tx_too_late, which charges no fee, instead of failing
 * on the predicate in a ledger, which does. Without it, the usual 300 s
 * timeout from now applies.
 */
export function buildClaimTransaction(
  claimantAccount: Account,
  balanceId: string,
  notAfter?: number,
): Transaction {
  const builder = new TransactionBuilder(claimantAccount, {
    fee: SETTLEMENT_FEE_BID,
    networkPassphrase: NETWORK_PASSPHRASE,
    ...(notAfter === undefined ? {} : { timebounds: { minTime: 0, maxTime: notAfter } }),
  }).addOperation(claimOperation(balanceId));
  return (notAfter === undefined ? builder.setTimeout(TX_TIMEOUT_SECONDS) : builder).build();
}
