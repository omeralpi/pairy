// The server never trusts a client-reported state change: it reads the
// transaction back from Horizon and checks it against what the trade says.
// Signatures are the contract the trade router relies on; keep them.

import {
  FeeBumpTransaction,
  MuxedAccount,
  NotFoundError,
  Operation,
  TransactionBuilder,
  type OperationRecord,
  type Transaction,
} from "@stellar/stellar-sdk";

import { toAsset, type AssetCode } from "./assets";
import { horizon } from "./horizon";
import { NETWORK_PASSPHRASE, lockClaimants, lockOperation } from "./settlement";

export type ExpectedLock = {
  seller: string;
  buyer: string;
  asset: AssetCode;
  /** Decimal string as stored on the trade, e.g. "25.5000000". */
  amount: string;
  windowSeconds: number;
  /**
   * The lock must have landed at or after this moment (the trade's creation).
   * Stops a seller replaying an older lock with the same parties and amount.
   */
  notBefore?: Date;
  /** The lock must have landed by this moment (shortly after a cancel). */
  notAfter?: Date;
};

/**
 * The ID of the balance a lock transaction creates: the SDK's own computation
 * for operation 0, which is the lock's only operation. Kept here, on the
 * reading side, so settlement.ts stays the stock calls that build the lock.
 */
export function lockBalanceId(lockTx: Transaction): string {
  return lockTx.getClaimableBalanceId(0);
}

/** A verification result written for the user. Anything else thrown here is a Horizon or network failure. */
export class VerifyError extends Error {}

/** The transaction is not this trade's lock. */
export class LockMismatchError extends VerifyError {}

async function loadSuccessfulTx(hash: string): Promise<{ tx: Transaction; createdAt: Date }> {
  let record;
  try {
    record = await horizon.transactions().transaction(hash).call();
  } catch (e) {
    if (e instanceof NotFoundError) {
      throw new VerifyError(`Transaction ${hash} was not found on Stellar testnet.`);
    }
    throw e;
  }
  if (!record.successful) {
    throw new VerifyError(`Transaction ${hash} failed on-chain.`);
  }
  const envelope = TransactionBuilder.fromXDR(
    record.envelope_xdr,
    NETWORK_PASSPHRASE,
  );
  // A fee bump changes who pays the fee, not what the inner transaction does.
  const tx = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
  return { tx, createdAt: new Date(record.created_at) };
}

function onlyOperation(tx: Transaction, hash: string): OperationRecord {
  if (tx.operations.length !== 1) {
    throw new LockMismatchError(
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
  { requireLive = true }: { requireLive?: boolean } = {},
): Promise<{ balanceId: string; createdAt: Date }> {
  const { tx, createdAt } = await loadSuccessfulTx(hash);
  if (expected.notBefore && createdAt < expected.notBefore) {
    throw new LockMismatchError(`The lock in ${hash} landed before this trade was opened; lock again for this trade.`);
  }
  if (expected.notAfter && createdAt > expected.notAfter) {
    throw new LockMismatchError(`The lock in ${hash} landed too long after this trade was cancelled to belong to it.`);
  }
  const op = onlyOperation(tx, hash);
  if (op.type !== "createClaimableBalance") {
    throw new LockMismatchError(
      `Transaction ${hash} is a ${op.type}, not a createClaimableBalance lock.`,
    );
  }

  const source = op.source ?? tx.source;
  if (source !== expected.seller) {
    throw new LockMismatchError(
      `The lock in ${hash} was funded by ${source}, not the trade's seller.`,
    );
  }

  if (!op.asset.equals(toAsset(expected.asset))) {
    throw new LockMismatchError(`The lock in ${hash} is not in ${expected.asset}.`);
  }

  // Round-trip the trade's amount through the SDK so "25.5" and "25.5000000"
  // compare equal.
  const want = Operation.fromXDRObject<Operation.CreateClaimableBalance>(
    lockOperation({ ...expected, asset: toAsset(expected.asset) }),
  );
  if (op.amount !== want.amount) {
    throw new LockMismatchError(
      `The lock in ${hash} holds ${op.amount} ${expected.asset}, not the agreed ${want.amount}.`,
    );
  }

  const claimants = lockClaimants(
    expected.buyer,
    expected.seller,
    expected.windowSeconds,
  );
  if (op.claimants.length !== claimants.length) {
    throw new LockMismatchError(
      `The lock in ${hash} has ${op.claimants.length} claimants; it must have exactly the buyer and the seller.`,
    );
  }
  const roles = ["buyer", "seller"];
  claimants.forEach((c, i) => {
    const got = op.claimants[i];
    if (got.destination !== c.destination) {
      throw new LockMismatchError(
        `Claimant ${i + 1} of the lock in ${hash} is ${got.destination}, not the trade's ${roles[i]}.`,
      );
    }
    if (got.predicate.toXDR("base64") !== c.predicate.toXDR("base64")) {
      throw new LockMismatchError(
        `The ${roles[i]}'s claim condition in ${hash} is not the agreed ${expected.windowSeconds}-second window.`,
      );
    }
  });

  // A lock that has already been claimed or taken back cannot back a new
  // trade. Reconciling a trade with the chain (findLockTx) skips this: there
  // the lock may legitimately have been claimed since.
  const balanceId = lockBalanceId(tx);
  if (!requireLive) return { balanceId, createdAt };
  try {
    await horizon.claimableBalances().claimableBalance(balanceId).call();
  } catch (e) {
    if (e instanceof NotFoundError) {
      throw new VerifyError(`The lock in ${hash} is no longer on the ledger; it was already claimed or taken back.`);
    }
    throw e;
  }
  return { balanceId, createdAt };
}

/** The most seller operations findLockTx reads back (10 pages of 200). */
const MAX_LOCK_SEARCH_PAGES = 10;
const PAGE_SIZE = 200;
/** Exact-looking locks from the seller worth a transaction fetch; more means something is wrong. */
const MAX_LOCK_CANDIDATES = 10;

/** Horizon's asset field on an operation record: "native" or "CODE:ISSUER". */
function horizonAsset(code: AssetCode): string {
  const asset = toAsset(code);
  return asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`;
}

type FoundLock = { hash: string; balanceId: string; createdAt: Date };

/**
 * Verifies candidate lock transactions for one trade, each at most once, and
 * keeps the earliest that is this trade's lock and not another trade's.
 */
function lockMatcher(expected: ExpectedLock, excludeBalanceIds: ReadonlySet<string>) {
  const asset = horizonAsset(expected.asset);
  const amount = Operation.fromXDRObject<Operation.CreateClaimableBalance>(
    lockOperation({ ...expected, asset: toAsset(expected.asset) }),
  ).amount;
  const claimants = [expected.buyer, expected.seller].join();
  const seen = new Set<string>();
  const m = {
    match: null as FoundLock | null,
    /** Whether a Horizon record's own fields already look like this trade's lock. */
    looksLike: (r: { asset: string; amount: string; claimants: { destination: string }[] }) =>
      r.asset === asset && r.amount === amount && r.claimants.map((c) => c.destination).join() === claimants,
    consider: async (hash: string) => {
      if (seen.has(hash)) return;
      seen.add(hash);
      if (seen.size > MAX_LOCK_CANDIDATES) {
        throw new VerifyError("The seller has too many identical locks to tell which one belongs to this trade.");
      }
      try {
        const found = await verifyLockTx(hash, expected, { requireLive: false });
        if (!excludeBalanceIds.has(found.balanceId) && (!m.match || found.createdAt < m.match.createdAt)) {
          m.match = { hash, ...found };
        }
      } catch (e) {
        if (!(e instanceof LockMismatchError)) throw e;
      }
    },
  };
  return m;
}

/** Checks the seller's live balances to the buyer; only the seller can sponsor these, so strangers cannot bury them. */
async function searchLiveLocks(expected: ExpectedLock, m: ReturnType<typeof lockMatcher>): Promise<void> {
  const live = await horizon.claimableBalances().sponsor(expected.seller).claimant(expected.buyer).limit(PAGE_SIZE).call();
  for (const b of live.records) {
    if (!m.looksLike(b)) continue;
    const created = await horizon.operations().forClaimableBalance(b.id).order("asc").limit(1).call();
    const op = created.records[0];
    if (op?.type === "create_claimable_balance" && op.transaction_successful) await m.consider(op.transaction_hash);
  }
}

/**
 * This trade's lock if it is still on the ledger: one query, for callers that
 * cannot afford findLockTx's history search each time.
 */
export async function findLiveLockTx(
  expected: ExpectedLock & { notBefore: Date },
  excludeBalanceIds: ReadonlySet<string> = new Set(),
): Promise<FoundLock | null> {
  const m = lockMatcher(expected, excludeBalanceIds);
  await searchLiveLocks(expected, m);
  return m.match;
}

/**
 * Finds this trade's lock on the ledger from the seller's own operations,
 * whether or not it has been claimed since. Only records whose source, asset,
 * amount and claimants already match are fetched, and each goes through
 * verifyLockTx, so only an exact Pairy lock for these parties, asset, amount
 * and window that landed between `notBefore` and `notAfter` counts. Balances
 * already backing another trade are skipped. Returns the earliest match.
 *
 * Anyone can push operations onto the seller's history (a payment to them is
 * one), so the search stops after MAX_LOCK_SEARCH_PAGES. Past that it falls
 * back to the seller's live balances to the buyer: a lock still on the ledger
 * is always found; only one already claimed that far back is not.
 */
export async function findLockTx(
  expected: ExpectedLock & { notBefore: Date },
  excludeBalanceIds: ReadonlySet<string> = new Set(),
): Promise<FoundLock | null> {
  const m = lockMatcher(expected, excludeBalanceIds);
  let page;
  try {
    page = await horizon.operations().forAccount(expected.seller).order("desc").limit(PAGE_SIZE).call();
  } catch (e) {
    // Horizon has no history for this account (never funded, or wiped by a
    // testnet reset), so it has made no lock.
    if (e instanceof NotFoundError) return null;
    throw e;
  }
  for (let n = 1; ; n++) {
    for (const op of page.records) {
      // Newest first: once past the trade's creation there is nothing more to find.
      if (new Date(op.created_at) < expected.notBefore) return m.match;
      if (expected.notAfter && new Date(op.created_at) > expected.notAfter) continue;
      // Other accounts can create balances naming the seller; those show up
      // here too, so filter on the record before paying for a fetch.
      if (
        op.type === "create_claimable_balance" &&
        op.transaction_successful &&
        op.source_account === expected.seller &&
        m.looksLike(op)
      ) {
        await m.consider(op.transaction_hash);
      }
    }
    if (page.records.length < PAGE_SIZE) return m.match;
    if (n === MAX_LOCK_SEARCH_PAGES) break;
    page = await page.next();
  }
  await searchLiveLocks(expected, m);
  return m.match;
}

/** The hash of the successful claim (by either claimant) of `balanceId`, or null. */
export async function findClaimTx(balanceId: string): Promise<string | null> {
  const page = await horizon.operations().forClaimableBalance(balanceId).limit(200).call();
  const claim = page.records.find(
    (op) => op.type === "claim_claimable_balance" && op.transaction_successful,
  );
  return claim?.transaction_hash ?? null;
}

/** A muxed M... address is a G... account plus an id; the account is what claims. */
function baseAccount(address: string): string {
  return address.startsWith("M") ? MuxedAccount.fromAddress(address, "0").baseAccount().accountId() : address;
}

/**
 * Confirms `hash` is a successful testnet tx that claimed `balanceId`.
 * Returns which account claimed it (buyer → claimed, seller → reclaimed).
 */
export async function verifyClaimTx(
  hash: string,
  balanceId: string,
): Promise<{ claimant: string }> {
  const { tx } = await loadSuccessfulTx(hash);
  // Wallets may bundle the claim with other operations (a trustline, say); a
  // successful transaction with exactly one claim of this balance is a claim.
  const claims = tx.operations.filter(
    (op): op is Operation.ClaimClaimableBalance =>
      op.type === "claimClaimableBalance" && op.balanceId === balanceId,
  );
  if (claims.length !== 1) {
    throw new VerifyError(`Transaction ${hash} does not claim this trade's balance ${balanceId}.`);
  }
  return { claimant: baseAccount(claims[0].source ?? tx.source) };
}
