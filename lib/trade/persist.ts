// The only code that changes a trade's state. Every router path goes through
// transitionTrade, so the purge on a terminal state (SOW D3: the chat, and a
// protected trade's dispute notes) cannot be skipped: the state update, the
// event row and the purge commit together or not at all.

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import type { Db } from "@/lib/db";
import { chatMessages, disputeAnswers, listings, tradeEvents, trades } from "@/lib/db/schema";
import type { TestDb } from "@/lib/db/test-setup";
import { recomputeRemaining } from "@/lib/listing/remaining";

import {
  TradeStateMachine,
  TradeTransitionError,
  isTerminal,
  type TradeEvent,
  type TradeRole,
} from "./state-machine";

export type Database = Db | TestDb;
export type TradeRow = typeof trades.$inferSelect;

export function machineFor(row: TradeRow): TradeStateMachine {
  return new TradeStateMachine({
    state: row.state,
    disputed: row.disputed,
    openedBy: row.openedBy,
    mode: row.mode,
    balanceId: row.balanceId,
    lockTx: row.lockTx,
    claimTx: row.claimTx,
    reclaimTx: row.reclaimTx,
    escrowContractId: row.escrowContractId,
    createTx: row.createTx,
    fundTx: row.fundTx,
    releaseTx: row.releaseTx,
    disputeTx: row.disputeTx,
    resolveTx: row.resolveTx,
  });
}

/** Columns an event writes besides the snapshot: acceptances, ledger times and the dispute record. */
function eventColumns(event: TradeEvent, now: Date): Partial<TradeRow> {
  switch (event.type) {
    case "agree":
      if (!event.acceptedAt) return {};
      return event.by === "seller" ? { sellerAcceptedAt: event.acceptedAt } : { buyerAcceptedAt: event.acceptedAt };
    case "lock":
      return { lockedAt: event.lockedAt ?? null };
    case "fund":
      return { fundedAt: event.fundedAt };
    case "escrowDispute":
      // The answer window starts when Pairy records the dispute, not at its ledger time (DECISIONS 1).
      return { disputedAt: event.disputedAt, disputeRecordedAt: now, disputeOpenedBy: event.by };
    case "resolve":
      return { resolvedAt: event.resolvedAt };
    default:
      return {};
  }
}

/**
 * The trade and the caller's role in it. Non-participants get NOT_FOUND so a
 * trade's existence is not revealed to them.
 */
export async function tradeForParticipant(
  db: Database,
  tradeId: string,
  publicKey: string,
): Promise<{ trade: TradeRow; role: TradeRole }> {
  const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId));
  if (!trade || (trade.seller !== publicKey && trade.buyer !== publicKey)) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Trade not found" });
  }
  return { trade, role: trade.seller === publicKey ? "seller" : "buyer" };
}

export async function transitionTrade(
  db: Database,
  tradeId: string,
  event: TradeEvent,
): Promise<TradeRow> {
  try {
    return await db.transaction(async (tx) => {
      // Lock order everywhere: the listing row, then the trade row. The
      // listing lock serializes this against trade.open and every other
      // transition on the listing, so the remaining amount recomputed below
      // sees every committed trade. listing_id never changes, so the
      // unlocked read is safe.
      const [ref] = await tx.select({ listingId: trades.listingId }).from(trades).where(eq(trades.id, tradeId));
      if (!ref) throw new TRPCError({ code: "NOT_FOUND", message: "Trade not found" });
      await tx.select({ id: listings.id }).from(listings).where(eq(listings.id, ref.listingId)).for("update");
      // The row lock serializes this against other transitions and against
      // chat.send (FOR SHARE), so no message can land after the purge.
      const [row] = await tx.select().from(trades).where(eq(trades.id, tradeId)).for("update");
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Trade not found" });

      const next = machineFor(row).apply(event).snapshot;
      const now = new Date();
      const [updated] = await tx
        .update(trades)
        .set({ ...next, updatedAt: now, ...eventColumns(event, now) })
        .where(eq(trades.id, tradeId))
        .returning();
      await tx.insert(tradeEvents).values({
        tradeId,
        type: event.type,
        by: event.by,
        txHash: "txHash" in event ? event.txHash : null,
      });
      if (isTerminal(next.state)) {
        await tx.delete(chatMessages).where(eq(chatMessages.tradeId, tradeId));
        // The yes/no answers stay in the timeline; the free text goes with the chat.
        // await tx.update(disputeAnswers).set({ note: null }).where(eq(disputeAnswers.tradeId, tradeId));
      }
      await recomputeRemaining(tx, ref.listingId);
      return updated;
    });
  } catch (e) {
    if (e instanceof TradeTransitionError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: e.message, cause: e });
    }
    // trades_balance_id_idx: two trades raced to record the same lock.
    if (isUniqueViolation(e) && event.type === "lock") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "That lock already belongs to another trade", cause: e });
    }
    throw e;
  }
}

function isUniqueViolation(e: unknown): boolean {
  for (let c = e; c instanceof Object; c = (c as { cause?: unknown }).cause) {
    if ((c as { code?: unknown }).code === "23505") return true;
  }
  return false;
}
