// Stellar testnet is wiped from time to time: every account, balance and lock
// is gone. Pairy's records then describe trades that can no longer move. This
// closes them (event "reset", which purges their chat), but only where the
// ledger shows it: a locked trade whose balance is gone with no claim of it on
// record, a protected trade whose escrow and its creation are both gone, or an
// unlocked one whose seller and buyer accounts are both gone, and only among
// trades opened before the reset (`before`): after it, a new user's key may
// simply not be funded yet. Run by hand after a reset:
// scripts/ops/testnet-reset.ts.

import { NotFoundError } from "@stellar/stellar-sdk";
import { and, inArray, lt } from "drizzle-orm";

import { trades } from "@/lib/db/schema";
import { EscrowNotFoundError, readWasmHash } from "@/lib/escrow/read";
import { horizon, loadAccount } from "@/lib/stellar/horizon";
import { findClaimTx } from "@/lib/stellar/verify";

import { transitionTrade, type Database, type TradeRow } from "./persist";

/**
 * FIXES F-13: an escrow is wiped only when its contract instance is gone from
 * the ledger and its creation transaction from Horizon. An archived instance
 * is still there (C-3); only EscrowNotFoundError means gone. SDF's Horizon
 * keeps full history, so a recorded successful transaction disappears only in
 * a reset. The traders' accounts are not consulted: users fund them again.
 */
async function escrowWiped(trade: TradeRow): Promise<boolean> {
  try {
    // Reads only the contract's instance entry.
    await readWasmHash(trade.escrowContractId!);
    return false;
  } catch (e) {
    if (!(e instanceof EscrowNotFoundError)) throw e;
  }
  return horizon
    .transactions()
    .transaction(trade.createTx!)
    .call()
    .then(
      () => false,
      (e) => {
        if (e instanceof NotFoundError) return true;
        throw e;
      },
    );
}

/** Whether the ledger no longer has anything this trade could still use. */
async function wipedByReset(trade: TradeRow): Promise<boolean> {
  if (trade.state === "escrow_created" || trade.state === "funded") return escrowWiped(trade);
  if (trade.state === "locked" && trade.balanceId) {
    const live = await horizon
      .claimableBalances()
      .claimableBalance(trade.balanceId)
      .call()
      .then(
        () => true,
        (e) => {
          if (e instanceof NotFoundError) return false;
          throw e;
        },
      );
    if (live) return false;
    // Claimed but never reported: that is for sync to record, not a reset.
    const claim = await findClaimTx(trade.balanceId).catch((e) => {
      if (e instanceof NotFoundError) return null;
      throw e;
    });
    return claim === null;
  }
  // An unfunded seller alone is not a reset; both parties gone is.
  const [seller, buyer] = await Promise.all([loadAccount(trade.seller), loadAccount(trade.buyer)]);
  return seller === null && buyer === null;
}

export async function closeResetTrades(
  db: Database,
  { apply, before }: { apply: boolean; before: Date },
): Promise<Pick<TradeRow, "id" | "state" | "seller" | "buyer" | "amount" | "asset">[]> {
  const open = await db
    .select()
    .from(trades)
    .where(and(inArray(trades.state, ["listed", "agreed", "locked", "escrow_created", "funded"]), lt(trades.createdAt, before)));
  const closed = [];
  for (const trade of open) {
    if (!(await wipedByReset(trade))) continue;
    if (apply) await transitionTrade(db, trade.id, { type: "reset", by: "system" });
    closed.push({ id: trade.id, state: trade.state, seller: trade.seller, buyer: trade.buyer, amount: trade.amount, asset: trade.asset });
  }
  return closed;
}
