// Shared fixtures for the trade/chat router tests. Callers must
// vi.mock("@/lib/stellar/verify") themselves (hoisting is per test file).

import { Keypair } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";

import { listings, tradeEvents, trades, users } from "@/lib/db/schema";
import { createTestDb, type TestDb } from "@/lib/db/test-setup";
import { ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { recomputeRemaining } from "@/lib/listing/remaining";
import type { AssetCode } from "@/lib/stellar/assets";
import { TradeStateMachine } from "@/lib/trade/state-machine";
import { appRouter } from "@/server/api/root";
import { createCallerFactory } from "@/server/api/trpc";

const createCaller = createCallerFactory(appRouter);

export function callerFor(db: TestDb, publicKey: string | null) {
  return createCaller({
    db,
    session: publicKey ? { publicKey } : null,
    resHeaders: new Headers(),
  });
}

export const TX = {
  lock: "a".repeat(64),
  claim: "b".repeat(64),
  reclaim: "c".repeat(64),
};

/** A db with three users and an active listing (sell_crypto XLM unless told otherwise) owned by `owner`. */
export async function tradeFixture(side: "sell_crypto" | "buy_crypto" = "sell_crypto", asset: AssetCode = "XLM") {
  const { db, client } = await createTestDb();
  const [owner, taker, stranger] = [0, 1, 2].map(() => Keypair.random().publicKey());
  await db.insert(users).values([owner, taker, stranger].map((publicKey) => ({ publicKey })));
  const [listing] = await db
    .insert(listings)
    .values({
      owner,
      side,
      asset,
      minAmount: "10",
      maxAmount: "100",
      remainingAmount: "100",
      fiatCode: "TRY",
      rate: "4.1250",
      cityId: "745044",
      cityName: "Istanbul",
      countryCode: "TR",
      latitude: "41.01384",
      longitude: "28.94966",
    })
    .returning();
  return {
    db,
    client,
    listing,
    owner,
    taker,
    stranger,
    as: (publicKey: string | null) => callerFor(db, publicKey),
  };
}

/**
 * A protected trade on a sell_crypto USDC listing, written the way
 * trade.open will write one (WP-24): the buyer opens it and accepts the
 * terms, and the amount is reserved under the listing lock.
 */
export async function openProtectedTrade(
  f: Awaited<ReturnType<typeof tradeFixture>>,
  amount: string,
  buyer = f.taker,
) {
  return f.db.transaction(async (tx) => {
    await tx.select({ id: listings.id }).from(listings).where(eq(listings.id, f.listing.id)).for("update");
    const [trade] = await tx
      .insert(trades)
      .values({
        ...TradeStateMachine.open("buyer", "protected").snapshot,
        listingId: f.listing.id,
        seller: f.owner,
        buyer,
        asset: f.listing.asset,
        amount,
        fiatCode: f.listing.fiatCode,
        fiatAmount: "1.00",
        windowSeconds: 0,
        acceptanceVersion: ACCEPTANCE_VERSION,
        buyerAcceptedAt: new Date(),
      })
      .returning();
    await tx.insert(tradeEvents).values({ tradeId: trade.id, type: "open", by: "buyer" });
    await recomputeRemaining(tx, f.listing.id);
    return trade;
  });
}
