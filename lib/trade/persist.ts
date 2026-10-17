// The only code that changes a trade's state. Every router path goes through
// transitionTrade, so the chat purge on a terminal state (SOW D3) cannot be
// skipped: the state update, the event row and the purge commit together or
// not at all.

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import type { Db } from "@/lib/db";
import { chatMessages, tradeEvents, trades } from "@/lib/db/schema";
import type { TestDb } from "@/lib/db/test-setup";

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
    balanceId: row.balanceId,
    lockTx: row.lockTx,
    claimTx: row.claimTx,
    reclaimTx: row.reclaimTx,
  });
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
      // The row lock serializes this against other transitions and against
      // chat.send (FOR SHARE), so no message can land after the purge.
      const [row] = await tx.select().from(trades).where(eq(trades.id, tradeId)).for("update");
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Trade not found" });

      const next = machineFor(row).apply(event).snapshot;
      const [updated] = await tx
        .update(trades)
        .set({ ...next, updatedAt: new Date(), ...(event.type === "lock" ? { lockedAt: event.lockedAt ?? null } : {}) })
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
      }
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
