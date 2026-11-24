// How much of a listing is still open to new trades (SOW D3). It is a stored
// column recomputed from the listing's trades, never an incremental counter:
// a counter drifts when a lock turns up on a cancelled trade after another
// trade took the amount (the clamp at 0 would later be "given back").
//
// Every caller holds the listing row lock (SELECT ... FOR UPDATE) when it
// calls recomputeRemaining, so the last transaction to commit always sums
// every committed trade. Lock order everywhere: listing row, then trade row.

import { eq, sql } from "drizzle-orm";

import { listings, trades } from "@/lib/db/schema";
import type { Database } from "@/lib/trade/persist";

/** Trade states whose amount still counts against the listing: reserved or used up. */
export const COUNTED_STATES = ["listed", "agreed", "locked", "claimed", "escrow_created", "funded", "released", "resolved_buyer"] as const;
// Not counted (given back): cancelled, reclaimed, resolved_seller (the arbiter refunded the seller in full).

export type DbTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Recomputes listings.remaining_amount from the listing's trades, under the
 * listing row lock the caller holds. Returns the new value.
 */
export async function recomputeRemaining(tx: DbTx, listingId: string): Promise<string> {
  const counted = sql.join(COUNTED_STATES.map((s) => sql`${s}`), sql`, `);
  // returning() without a field map: the Db | TestDb union loses that overload.
  const [row] = await tx
    .update(listings)
    .set({
      remainingAmount: sql`greatest(0, ${listings.maxAmount} - coalesce((select sum(${trades.amount}) from ${trades} where ${trades.listingId} = ${listings.id} and ${trades.state}::text in (${counted})), 0))`,
    })
    .where(eq(listings.id, listingId))
    .returning();
  return row.remainingAmount;
}
