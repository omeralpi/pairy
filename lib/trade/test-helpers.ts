// Shared fixtures for the trade/chat router tests. Callers must
// vi.mock("@/lib/stellar/verify") themselves (hoisting is per test file).

import { Keypair } from "@stellar/stellar-sdk";

import { listings, users } from "@/lib/db/schema";
import { createTestDb, type TestDb } from "@/lib/db/test-setup";
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

/** A db with three users and an active sell_crypto XLM listing owned by `owner`. */
export async function tradeFixture(side: "sell_crypto" | "buy_crypto" = "sell_crypto") {
  const { db, client } = await createTestDb();
  const [owner, taker, stranger] = [0, 1, 2].map(() => Keypair.random().publicKey());
  await db.insert(users).values([owner, taker, stranger].map((publicKey) => ({ publicKey })));
  const [listing] = await db
    .insert(listings)
    .values({
      owner,
      side,
      asset: "XLM",
      minAmount: "10",
      maxAmount: "100",
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
