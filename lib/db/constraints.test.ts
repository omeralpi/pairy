import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it } from "vitest";

import { listings, trades, users } from "./schema";
import { createTestDb, type TestDb } from "./test-setup";

// The database itself refuses rows the state machine can never produce, so a
// bug outside transitionTrade cannot persist one.

let db: TestDb;
let seller: string;
let buyer: string;
let listingId: string;

const listing = () => ({
  owner: seller,
  side: "sell_crypto" as const,
  asset: "XLM" as const,
  minAmount: "10",
  maxAmount: "100",
  fiatCode: "TRY",
  rate: "4.1250",
  cityId: "745044",
  cityName: "Istanbul",
  countryCode: "TR",
  latitude: "41.01384",
  longitude: "28.94966",
});

const trade = () => ({
  listingId,
  seller,
  buyer,
  openedBy: "buyer" as const,
  asset: "XLM" as const,
  amount: "20",
  fiatCode: "TRY",
  fiatAmount: "82.50",
  windowSeconds: 259200,
});

const locked = { balanceId: "00".repeat(36), lockTx: "a".repeat(64) };

beforeEach(async () => {
  ({ db } = await createTestDb());
  [seller, buyer] = [0, 1].map(() => Keypair.random().publicKey());
  await db.insert(users).values([{ publicKey: seller }, { publicKey: buyer }]);
  [{ id: listingId }] = await db.insert(listings).values(listing()).returning();
});

describe("trades CHECK constraints", () => {
  it("accepts rows the state machine produces", async () => {
    await db.insert(trades).values(trade());
    await db.insert(trades).values({ ...trade(), state: "locked", ...locked });
    await db
      .insert(trades)
      .values({ ...trade(), state: "claimed", balanceId: "01".repeat(36), lockTx: "a".repeat(64), claimTx: "b".repeat(64) });
    await db
      .insert(trades)
      .values({ ...trade(), state: "reclaimed", balanceId: "02".repeat(36), lockTx: "a".repeat(64), reclaimTx: "c".repeat(64) });
  });

  it.each([
    ["seller = buyer", "trades_seller_not_buyer", () => ({ ...trade(), buyer: seller })],
    ["amount = 0", "trades_amount_positive", () => ({ ...trade(), amount: "0" })],
    ["amount < 0", "trades_amount_positive", () => ({ ...trade(), amount: "-5" })],
    ["fiat_amount < 0", "trades_fiat_amount_nonnegative", () => ({ ...trade(), fiatAmount: "-0.01" })],
    ["locked without balance_id", "trades_lock_recorded", () => ({ ...trade(), state: "locked" as const, lockTx: locked.lockTx })],
    ["locked without lock_tx", "trades_lock_recorded", () => ({ ...trade(), state: "locked" as const, balanceId: locked.balanceId })],
    ["claimed without balance_id", "trades_lock_recorded", () => ({ ...trade(), state: "claimed" as const, claimTx: "b".repeat(64) })],
    ["claimed without claim_tx", "trades_claim_recorded", () => ({ ...trade(), state: "claimed" as const, ...locked })],
    ["reclaimed without reclaim_tx", "trades_reclaim_recorded", () => ({ ...trade(), state: "reclaimed" as const, ...locked })],
  ])("rejects %s (%s)", async (_, constraint, row) => {
    await expect(db.insert(trades).values(row())).rejects.toMatchObject({ cause: { constraint } });
  });
});

describe("listings CHECK constraints", () => {
  it.each([
    ["min_amount = 0", "listings_min_amount_positive", () => ({ ...listing(), minAmount: "0" })],
    ["min_amount < 0", "listings_min_amount_positive", () => ({ ...listing(), minAmount: "-1" })],
    ["max_amount < min_amount", "listings_max_amount_gte_min", () => ({ ...listing(), minAmount: "50", maxAmount: "49.9999999" })],
    ["rate = 0", "listings_rate_positive", () => ({ ...listing(), rate: "0" })],
    ["rate < 0", "listings_rate_positive", () => ({ ...listing(), rate: "-4.1250" })],
  ])("rejects %s (%s)", async (_, constraint, row) => {
    await expect(db.insert(listings).values(row())).rejects.toMatchObject({ cause: { constraint } });
  });

  it("accepts min equal to max", async () => {
    await db.insert(listings).values({ ...listing(), minAmount: "25", maxAmount: "25" });
  });
});
