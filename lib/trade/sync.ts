// Brings a trade's record in line with the ledger. The chain outranks the
// app: a lock or claim that landed but was never reported (a closed tab, a
// failed request, a cancel that raced the lock) is found on Horizon and
// recorded through the normal transitions.
//
// Nothing on chain names the trade a lock is for, only its terms. So a lock is
// matched to a trade only where it can have been made for it: an agreed trade
// with no identical agreed twin, or one cancelled after agreement while the
// seller may still have been signing, and never past the moment the next trade
// with the same terms opened.

import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, isNotNull, isNull, lt, ne, or } from "drizzle-orm";

import { tradeEvents, trades } from "@/lib/db/schema";
import {
  VerifyError,
  findClaimTx,
  findLiveLockTx,
  findLockTx,
  verifyClaimTx,
  type ExpectedLock,
} from "@/lib/stellar/verify";

import { transitionTrade, type Database, type TradeRow } from "./persist";

/** How long after a cancel a lock the seller was already signing may still land. */
export const CANCEL_LOCK_GRACE_MS = 15 * 60 * 1000;

/** The least time between two Horizon searches for one trade by sync or preflight. */
export const SYNC_INTERVAL_MS = 10_000;

/**
 * A Horizon or verification failure as a BAD_REQUEST: verification results
 * keep their message, network and Horizon errors get a generic one.
 */
export async function chain<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        e instanceof VerifyError
          ? e.message
          : "Could not reach Stellar testnet right now. Try again in a minute.",
      cause: e,
    });
  }
}

/** Other trades between the same people for the same asset and amount. */
const sameTerms = (trade: TradeRow) =>
  and(
    eq(trades.seller, trade.seller),
    eq(trades.buyer, trade.buyer),
    eq(trades.asset, trade.asset),
    eq(trades.amount, trade.amount),
    ne(trades.id, trade.id),
  );

/** What a lock for this trade must look like, or null if it cannot take one. */
export async function expectedLock(
  db: Database,
  trade: TradeRow,
): Promise<(ExpectedLock & { notBefore: Date }) | null> {
  const expected = {
    seller: trade.seller,
    buyer: trade.buyer,
    asset: trade.asset,
    amount: trade.amount,
    windowSeconds: trade.windowSeconds,
    notBefore: trade.createdAt,
  };
  if (trade.state === "agreed") return expected;
  if (trade.state !== "cancelled" || trade.balanceId) return null;

  const events = await db
    .select({ type: tradeEvents.type, createdAt: tradeEvents.createdAt })
    .from(tradeEvents)
    .where(eq(tradeEvents.tradeId, trade.id));
  const cancel = events.find((e) => e.type === "cancel" || e.type === "expire");
  // A seller who never agreed was never shown a lock to sign.
  if (!cancel || !events.some((e) => e.type === "agree")) return null;
  // A live trade with the same terms is the one waiting for a lock.
  const [twin] = await db
    .select({ id: trades.id })
    .from(trades)
    .where(and(sameTerms(trade), eq(trades.state, "agreed")));
  if (twin) return null;
  // A lock after the next same-terms trade opened may be for that one.
  const [next] = await db
    .select({ createdAt: trades.createdAt })
    .from(trades)
    .where(and(sameTerms(trade), gt(trades.createdAt, trade.createdAt)))
    .orderBy(asc(trades.createdAt))
    .limit(1);
  const graceEnd = cancel.createdAt.getTime() + CANCEL_LOCK_GRACE_MS;
  return { ...expected, notAfter: new Date(next ? Math.min(graceEnd, next.createdAt.getTime()) : graceEnd) };
}

/**
 * The on-chain lock for this trade, if one landed and is not another trade's.
 * `liveOnly` checks only locks still on the ledger: one Horizon query instead
 * of a history search.
 */
export async function findTradeLock(db: Database, trade: TradeRow, { liveOnly = false } = {}) {
  const expected = await expectedLock(db, trade);
  if (!expected) return null;
  if (trade.state === "agreed") {
    // Two agreed trades with the same terms: a lock could be for either, so
    // only the seller's own report (recordLock) can place it.
    const [twin] = await db
      .select({ id: trades.id })
      .from(trades)
      .where(and(sameTerms(trade), eq(trades.state, "agreed")));
    if (twin) return null;
  }
  const taken = await db
    .select({ balanceId: trades.balanceId })
    .from(trades)
    .where(and(eq(trades.seller, trade.seller), isNotNull(trades.balanceId), ne(trades.id, trade.id)));
  const exclude = new Set(taken.map((t) => t.balanceId!));
  return chain(liveOnly ? findLiveLockTx(expected, exclude) : findLockTx(expected, exclude));
}

export async function syncTrade(db: Database, trade: TradeRow): Promise<TradeRow> {
  let row = trade;
  const lock = await findTradeLock(db, row);
  if (lock) {
    row = await transitionTrade(db, row.id, {
      type: "lock",
      by: "seller",
      balanceId: lock.balanceId,
      txHash: lock.hash,
      lockedAt: lock.createdAt,
      reconcile: true,
    });
  }
  if (row.state === "locked" && row.balanceId) {
    const balanceId = row.balanceId;
    const hash = await chain(findClaimTx(balanceId));
    if (hash) {
      const { claimant } = await chain(verifyClaimTx(hash, balanceId));
      if (claimant === row.buyer) {
        row = await transitionTrade(db, row.id, { type: "claim", by: "buyer", txHash: hash });
      } else if (claimant === row.seller) {
        row = await transitionTrade(db, row.id, { type: "reclaim", by: "seller", txHash: hash });
      }
    }
  }
  return row;
}

/**
 * syncTrade at most once per SYNC_INTERVAL_MS per trade, however many tabs or
 * callers poll it. Returns null when a search ran too recently. A failed sync
 * gives its slot back so the next call searches again.
 */
export async function syncIfDue(db: Database, trade: TradeRow): Promise<TradeRow | null> {
  const [due] = await db
    .update(trades)
    .set({ lastSyncedAt: new Date() })
    .where(
      and(
        eq(trades.id, trade.id),
        or(isNull(trades.lastSyncedAt), lt(trades.lastSyncedAt, new Date(Date.now() - SYNC_INTERVAL_MS))),
      ),
    )
    // returning() without a field map: the Db | TestDb union loses that overload.
    .returning();
  if (!due) return null;
  try {
    return await syncTrade(db, due);
  } catch (e) {
    await db.update(trades).set({ lastSyncedAt: trade.lastSyncedAt }).where(eq(trades.id, trade.id));
    throw e;
  }
}
