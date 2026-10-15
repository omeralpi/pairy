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
//   buyer  — BEFORE_RELATIVE_TIME(window)        claims at the meeting
//   seller — NOT(BEFORE_RELATIVE_TIME(window))   reclaims once the window closes

import {
  Asset,
  BASE_FEE,
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

/** Unsigned lock transaction, sourced from the seller's account. */
export function buildLockTransaction(
  sellerAccount: Account,
  params: Omit<LockParams, "seller">,
): Transaction {
  return new TransactionBuilder(sellerAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      lockOperation({ ...params, seller: sellerAccount.accountId() }),
    )
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
}

/** Unsigned claim (buyer) or reclaim (seller) transaction. */
export function buildClaimTransaction(
  claimantAccount: Account,
  balanceId: string,
): Transaction {
  return new TransactionBuilder(claimantAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(claimOperation(balanceId))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
}

/**
 * The ID of the balance a lock transaction creates. The lock is always the
 * transaction's only operation, so this is the SDK's own computation for
 * operation 0.
 */
export function lockBalanceId(lockTx: Transaction): string {
  return lockTx.getClaimableBalanceId(0);
}
