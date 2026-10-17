// Ends trades nobody uses any more, so their chat does not outlive them: the
// SOW has chat purged server-side when a trade ends, not left to the parties
// to delete. Run once a day by Vercel Cron (app/api/cron/expire-trades).
//
// - A listed or agreed trade with no state change and no chat message for a
//   week is cancelled (event "expire"), which purges its chat. An agreed one
//   is first checked against the ledger: a lock found there is recorded
//   instead, and if Stellar can't be read the trade is left for the next run.
// - A locked trade can't be cancelled: the money is on the ledger. Once the
//   buyer's claim window closed a week ago there is nothing left to arrange,
//   so its chat is deleted and the trade stays as the chain has it.
// - A flagged (disputed) trade is never touched: its chat is the evidence a
//   Phase 2 arbiter would need. Nor is an agreed trade with an identical
//   agreed twin, since a lock on chain could belong to either.

import { and, asc, eq, exists, gte, inArray, lt, ne, notExists, sql } from "drizzle-orm";

import { chatMessages, trades } from "@/lib/db/schema";

import { transitionTrade, type Database, type TradeRow } from "./persist";
import { syncTrade } from "./sync";

/** A week without a state change or a chat message. */
export const IDLE_TRADE_MS = 7 * 24 * 60 * 60 * 1000;

/** Trades looked at per run and per kind; an agreed one costs a Horizon search. */
const BATCH = 25;

export async function expireIdleTrades(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - IDLE_TRADE_MS);
  const result = { expired: 0, skipped: 0, purged: 0 };

  const idle = await db
    .select()
    .from(trades)
    .where(
      and(
        inArray(trades.state, ["listed", "agreed"]),
        eq(trades.disputed, false),
        lt(trades.updatedAt, cutoff),
        notExists(
          db
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(and(eq(chatMessages.tradeId, trades.id), gte(chatMessages.createdAt, cutoff))),
        ),
      ),
    )
    // Trades skipped on an earlier run (stamped below) go to the back.
    .orderBy(sql`${trades.lastSyncedAt} asc nulls first`, asc(trades.updatedAt))
    .limit(BATCH);
  for (const trade of idle) {
    try {
      if (trade.state === "agreed") {
        if (await hasAgreedTwin(db, trade)) {
          result.skipped++;
          await stamp(db, trade.id, now);
          continue;
        }
        if ((await syncTrade(db, trade)).state !== "agreed") continue;
      }
      await transitionTrade(db, trade.id, { type: "expire", by: "system" });
      result.expired++;
    } catch {
      // Stellar unreachable, or the trade moved on meanwhile: next run.
      result.skipped++;
      await stamp(db, trade.id, now);
    }
  }

  // Older rows have no ledger lock time; their last update is no earlier.
  const lockedAt = sql`coalesce(${trades.lockedAt}, ${trades.updatedAt})`;
  const stale = await db
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.state, "locked"),
        eq(trades.disputed, false),
        sql`${lockedAt} + ${trades.windowSeconds} * interval '1 second' < ${cutoff.toISOString()}::timestamptz`,
        // Once purged, a trade the seller never takes back stays locked
        // forever; leave it out so newer ones are always reached.
        exists(db.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.tradeId, trades.id))),
      ),
    )
    .orderBy(asc(trades.updatedAt))
    .limit(BATCH);
  for (const trade of stale) {
    try {
      // A claim or take-back that was never reported ends the trade (and purges) here.
      if ((await syncTrade(db, trade)).state !== "locked") continue;
      const deleted = await db.delete(chatMessages).where(eq(chatMessages.tradeId, trade.id)).returning();
      if (deleted.length > 0) result.purged++;
    } catch {
      result.skipped++;
    }
  }
  return result;
}

async function hasAgreedTwin(db: Database, trade: TradeRow): Promise<boolean> {
  const [twin] = await db
    .select({ id: trades.id })
    .from(trades)
    .where(
      and(
        eq(trades.seller, trade.seller),
        eq(trades.buyer, trade.buyer),
        eq(trades.asset, trade.asset),
        eq(trades.amount, trade.amount),
        eq(trades.state, "agreed"),
        ne(trades.id, trade.id),
      ),
    );
  return twin !== undefined;
}

/** Marks a trade looked at, so the next run reaches the others first. */
async function stamp(db: Database, id: string, now: Date) {
  await db.update(trades).set({ lastSyncedAt: now }).where(eq(trades.id, id));
}
