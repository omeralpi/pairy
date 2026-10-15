// The server never trusts a client-reported state change: it reads the
// transaction back from Horizon and checks it against what the trade says.
// Signatures are the contract the trade router relies on; keep them.

import {
  FeeBumpTransaction,
  NotFoundError,
  Operation,
  TransactionBuilder,
  type OperationRecord,
  type Transaction,
} from "@stellar/stellar-sdk";

import { toAsset, type AssetCode } from "./assets";
import { horizon } from "./horizon";
import {
  NETWORK_PASSPHRASE,
  lockBalanceId,
  lockClaimants,
  lockOperation,
} from "./settlement";

export type ExpectedLock = {
  seller: string;
  buyer: string;
  asset: AssetCode;
  /** Decimal string as stored on the trade, e.g. "25.5000000". */
  amount: string;
  windowSeconds: number;
};

async function loadSuccessfulTx(hash: string): Promise<Transaction> {
  let record;
  try {
    record = await horizon.transactions().transaction(hash).call();
  } catch (e) {
    if (e instanceof NotFoundError) {
      throw new Error(`Transaction ${hash} was not found on Stellar testnet.`);
    }
    throw e;
  }
  if (!record.successful) {
    throw new Error(`Transaction ${hash} failed on-chain.`);
  }
  const envelope = TransactionBuilder.fromXDR(
    record.envelope_xdr,
    NETWORK_PASSPHRASE,
  );
  // A fee bump changes who pays the fee, not what the inner transaction does.
  return envelope instanceof FeeBumpTransaction
    ? envelope.innerTransaction
    : envelope;
}

function onlyOperation(tx: Transaction, hash: string): OperationRecord {
  if (tx.operations.length !== 1) {
    throw new Error(
      `Transaction ${hash} has ${tx.operations.length} operations; a Pairy settlement transaction has exactly one.`,
    );
  }
  return tx.operations[0];
}

/**
 * Confirms `hash` is a successful testnet tx whose only op is a
 * createClaimableBalance from `seller` with exactly the two Pairy claimants.
 * Returns the created balance ID. Throws with a human-readable reason otherwise.
 */
export async function verifyLockTx(
  hash: string,
  expected: ExpectedLock,
): Promise<{ balanceId: string }> {
  const tx = await loadSuccessfulTx(hash);
  const op = onlyOperation(tx, hash);
  if (op.type !== "createClaimableBalance") {
    throw new Error(
      `Transaction ${hash} is a ${op.type}, not a createClaimableBalance lock.`,
    );
  }

  const source = op.source ?? tx.source;
  if (source !== expected.seller) {
    throw new Error(
      `The lock in ${hash} was funded by ${source}, not the trade's seller.`,
    );
  }

  if (!op.asset.equals(toAsset(expected.asset))) {
    throw new Error(`The lock in ${hash} is not in ${expected.asset}.`);
  }

  // Round-trip the trade's amount through the SDK so "25.5" and "25.5000000"
  // compare equal.
  const want = Operation.fromXDRObject<Operation.CreateClaimableBalance>(
    lockOperation({ ...expected, asset: toAsset(expected.asset) }),
  );
  if (op.amount !== want.amount) {
    throw new Error(
      `The lock in ${hash} holds ${op.amount} ${expected.asset}, not the agreed ${want.amount}.`,
    );
  }

  const claimants = lockClaimants(
    expected.buyer,
    expected.seller,
    expected.windowSeconds,
  );
  if (op.claimants.length !== claimants.length) {
    throw new Error(
      `The lock in ${hash} has ${op.claimants.length} claimants; it must have exactly the buyer and the seller.`,
    );
  }
  const roles = ["buyer", "seller"];
  claimants.forEach((c, i) => {
    const got = op.claimants[i];
    if (got.destination !== c.destination) {
      throw new Error(
        `Claimant ${i + 1} of the lock in ${hash} is ${got.destination}, not the trade's ${roles[i]}.`,
      );
    }
    if (got.predicate.toXDR("base64") !== c.predicate.toXDR("base64")) {
      throw new Error(
        `The ${roles[i]}'s claim condition in ${hash} is not the agreed ${expected.windowSeconds}-second window.`,
      );
    }
  });

  return { balanceId: lockBalanceId(tx) };
}

/**
 * Confirms `hash` is a successful testnet tx that claimed `balanceId`.
 * Returns which account claimed it (buyer → claimed, seller → reclaimed).
 */
export async function verifyClaimTx(
  hash: string,
  balanceId: string,
): Promise<{ claimant: string }> {
  const tx = await loadSuccessfulTx(hash);
  const op = onlyOperation(tx, hash);
  if (op.type !== "claimClaimableBalance") {
    throw new Error(
      `Transaction ${hash} is a ${op.type}, not a claimClaimableBalance.`,
    );
  }
  if (op.balanceId !== balanceId) {
    throw new Error(
      `Transaction ${hash} claimed balance ${op.balanceId}, not this trade's ${balanceId}.`,
    );
  }
  return { claimant: op.source ?? tx.source };
}
