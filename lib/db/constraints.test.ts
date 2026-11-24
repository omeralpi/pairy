import { Keypair } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { arbiterResolutions, disputeAnswers, listings, trades, users } from "./schema";
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
  remainingAmount: "100",
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
    ["remaining_amount < 0", "listings_remaining_in_range", () => ({ ...listing(), remainingAmount: "-1" })],
    ["remaining_amount > max_amount", "listings_remaining_in_range", () => ({ ...listing(), remainingAmount: "100.0000001" })],
  ])("rejects %s (%s)", async (_, constraint, row) => {
    await expect(db.insert(listings).values(row())).rejects.toMatchObject({ cause: { constraint } });
  });

  it("accepts min equal to max", async () => {
    await db.insert(listings).values({ ...listing(), minAmount: "25", maxAmount: "25", remainingAmount: "25" });
  });
});

// Protected trades (D2 §3): the escrow columns each state needs, the mode's
// own states, USDC only, and both acceptances once agreed.
const accepted = { acceptanceVersion: "c785c11a", sellerAcceptedAt: new Date(), buyerAcceptedAt: new Date() };
const opened = () => ({ ...trade(), mode: "protected" as const, asset: "USDC" as const, windowSeconds: 0, acceptanceVersion: "c785c11a", buyerAcceptedAt: new Date() });
const agreed = () => ({ ...opened(), ...accepted, state: "agreed" as const });
let contracts = 0;
const escrow = () => ({
  escrowAdmin: Keypair.random().publicKey(),
  escrowContractId: `C${String(++contracts).padStart(55, "A")}`,
  createTx: "d".repeat(64),
});
const created = () => ({ ...agreed(), ...escrow(), state: "escrow_created" as const });
const funded = () => ({ ...created(), state: "funded" as const, fundTx: "e".repeat(64), fundedAt: new Date() });
const dispute = { disputed: true, disputeTx: "f".repeat(64), disputedAt: new Date(), disputeRecordedAt: new Date(), disputeOpenedBy: "buyer" as const };
const disputed = () => ({ ...funded(), ...dispute });

describe("protected trades CHECK constraints", () => {
  it("accepts every row the protected machine produces", async () => {
    await db.insert(trades).values([
      opened(),
      agreed(),
      // F-02: prepareCreate stores the contract id while the trade is still agreed.
      { ...agreed(), escrowAdmin: Keypair.random().publicKey(), escrowContractId: "C" + "P".repeat(55) },
      created(),
      funded(),
      disputed(),
      { ...funded(), state: "released", releaseTx: "1".repeat(64) },
      { ...disputed(), state: "resolved_buyer", resolveTx: "2".repeat(64), resolvedAt: new Date() },
      { ...disputed(), state: "resolved_seller", resolveTx: "3".repeat(64), resolvedAt: new Date() },
      { ...opened(), state: "cancelled" },
      { ...created(), state: "cancelled" },
    ]);
    // A claimable trade keeps its plain dispute flag.
    await db.insert(trades).values({ ...trade(), disputed: true });
  });

  it.each([
    ["a protected XLM trade", "trades_protected_usdc", () => ({ ...opened(), asset: "XLM" as const })],
    ["protected without acceptance_version", "trades_protected_terms", () => ({ ...opened(), acceptanceVersion: null })],
    ["claimable with acceptance_version", "trades_protected_terms", () => ({ ...trade(), acceptanceVersion: "c785c11a" })],
    ["claimable in escrow_created", "trades_mode_states", () => ({ ...trade(), ...escrow(), state: "escrow_created" as const })],
    ["claimable in released", "trades_mode_states", () => ({ ...trade(), ...escrow(), state: "released" as const, fundTx: "e".repeat(64), fundedAt: new Date(), releaseTx: "1".repeat(64) })],
    ["protected in locked", "trades_mode_states", () => ({ ...agreed(), ...locked, state: "locked" as const })],
    ["protected in claimed", "trades_mode_states", () => ({ ...agreed(), ...locked, state: "claimed" as const, claimTx: "b".repeat(64) })],
    ["escrow_created without escrow_contract_id", "trades_escrow_recorded", () => ({ ...created(), escrowContractId: null })],
    ["escrow_created without create_tx", "trades_escrow_recorded", () => ({ ...created(), createTx: null })],
    ["escrow_created without escrow_admin", "trades_escrow_recorded", () => ({ ...created(), escrowAdmin: null })],
    ["resolved_seller without escrow_contract_id", "trades_escrow_recorded", () => ({ ...disputed(), state: "resolved_seller" as const, resolveTx: "3".repeat(64), escrowContractId: null })],
    ["funded without fund_tx", "trades_fund_recorded", () => ({ ...funded(), fundTx: null })],
    ["funded without funded_at", "trades_fund_recorded", () => ({ ...funded(), fundedAt: null })],
    ["released without fund_tx", "trades_fund_recorded", () => ({ ...funded(), state: "released" as const, releaseTx: "1".repeat(64), fundTx: null })],
    ["released without release_tx", "trades_release_recorded", () => ({ ...funded(), state: "released" as const })],
    ["resolved_buyer without resolve_tx", "trades_resolve_recorded", () => ({ ...disputed(), state: "resolved_buyer" as const })],
    ["resolved_seller without dispute_tx", "trades_resolve_recorded", () => ({ ...funded(), state: "resolved_seller" as const, resolveTx: "3".repeat(64) })],
    ["disputed without dispute_tx", "trades_dispute_recorded", () => ({ ...disputed(), disputeTx: null })],
    ["disputed without disputed_at", "trades_dispute_recorded", () => ({ ...disputed(), disputedAt: null })],
    ["disputed without dispute_recorded_at", "trades_dispute_recorded", () => ({ ...disputed(), disputeRecordedAt: null })],
    ["disputed without dispute_opened_by", "trades_dispute_recorded", () => ({ ...disputed(), disputeOpenedBy: null })],
    ["agreed without the buyer's acceptance", "trades_protected_accepted", () => ({ ...agreed(), buyerAcceptedAt: null })],
    ["funded without the seller's acceptance", "trades_protected_accepted", () => ({ ...funded(), sellerAcceptedAt: null })],
  ])("rejects %s (%s)", async (_, constraint, row) => {
    await expect(db.insert(trades).values(row())).rejects.toMatchObject({ cause: { constraint } });
  });

  it("refuses a second trade on the same escrow (trades_escrow_contract_idx)", async () => {
    const first = created();
    await db.insert(trades).values(first);
    await expect(
      db.insert(trades).values({ ...created(), escrowContractId: first.escrowContractId }),
    ).rejects.toMatchObject({ cause: { constraint: "trades_escrow_contract_idx" } });
  });
});

describe("dispute_answers", () => {
  let tradeId: string;
  beforeEach(async () => {
    [{ id: tradeId }] = await db.insert(trades).values(disputed()).returning();
  });

  it("keeps one answer per side and never a second (DECISIONS 10)", async () => {
    await db.insert(disputeAnswers).values([
      { tradeId, role: "seller", cashHandedOver: true },
      { tradeId, role: "buyer", cashHandedOver: false, note: "x".repeat(500) },
    ]);
    await expect(
      db.insert(disputeAnswers).values({ tradeId, role: "seller", cashHandedOver: false }),
    ).rejects.toMatchObject({ cause: { constraint: "dispute_answers_trade_id_role_pk" } });
  });

  it("refuses a note over 500 characters (dispute_answers_note_length)", async () => {
    await expect(
      db.insert(disputeAnswers).values({ tradeId, role: "buyer", cashHandedOver: true, note: "x".repeat(501) }),
    ).rejects.toMatchObject({ cause: { constraint: "dispute_answers_note_length" } });
  });
});

describe("arbiter_resolutions", () => {
  let tradeIds: string[];
  beforeEach(async () => {
    tradeIds = (await db.insert(trades).values([disputed(), disputed()]).returning()).map((t) => t.id);
  });
  const resolution = (tradeId: string) => ({
    tradeId,
    outcome: "seller" as const,
    rule: 3,
    recipient: seller,
    amount: "20",
    unsignedXdr: "AAAA",
    txHash: "9".repeat(64),
    signedXdr: "AAAA",
    preparedBy: buyer,
  });

  it("starts collecting with no signers, and may have no expiry (F-11)", async () => {
    const [row] = await db.insert(arbiterResolutions).values(resolution(tradeIds[0])).returning();
    expect(row).toMatchObject({ status: "collecting", signers: [], expiresAt: null, submittedTx: null });
  });

  it.each([0, 4])("refuses rule %d (arbiter_resolutions_rule_valid)", async (rule) => {
    await expect(
      db.insert(arbiterResolutions).values({ ...resolution(tradeIds[0]), rule }),
    ).rejects.toMatchObject({ cause: { constraint: "arbiter_resolutions_rule_valid" } });
  });

  it("holds at most one collecting resolution in the whole table (F-03)", async () => {
    const [first] = await db.insert(arbiterResolutions).values(resolution(tradeIds[0])).returning();
    await expect(db.insert(arbiterResolutions).values(resolution(tradeIds[1]))).rejects.toMatchObject({
      cause: { constraint: "arbiter_resolutions_one_open" },
    });
    // Once the first is no longer collecting, the next one may start.
    await db.update(arbiterResolutions).set({ status: "expired" }).where(eq(arbiterResolutions.id, first.id));
    await db.insert(arbiterResolutions).values(resolution(tradeIds[1]));
    await db.insert(arbiterResolutions).values({ ...resolution(tradeIds[0]), status: "failed" });
  });
});
