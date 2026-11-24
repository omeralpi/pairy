// transitionTrade on protected trades (D2 §4): each chain event writes its
// transaction and ledger time next to the state, a dispute records when Pairy
// recorded it (the answer window starts there, DECISIONS 1), and a terminal
// state deletes the chat and every answer's note while the yes/no answers stay.

import { Keypair } from "@stellar/stellar-sdk";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { chatMessages, disputeAnswers, tradeEvents, trades } from "@/lib/db/schema";

import { transitionTrade } from "./persist";
import { openProtectedTrade, tradeFixture } from "./test-helpers";

const HASH = { create: "d".repeat(64), fund: "e".repeat(64), dispute: "f".repeat(64), release: "1".repeat(64), resolve: "9".repeat(64) };
let f: Awaited<ReturnType<typeof tradeFixture>>;

beforeEach(async () => {
  f = await tradeFixture("sell_crypto", "USDC");
});

const row = async (id: string) => (await f.db.select().from(trades).where(eq(trades.id, id)))[0];
const chatCount = async (id: string) => (await f.db.select().from(chatMessages).where(eq(chatMessages.tradeId, id))).length;
const contractFor = (id: string) => `C${id.replace(/-/g, "").toUpperCase().padEnd(55, "A")}`;

/** Opened by the buyer, agreed by the seller, escrow created (admin and contract stored at prepare, WP-24). */
async function createdTrade(amount = "20", buyer = f.taker) {
  const t = await openProtectedTrade(f, amount, buyer);
  await transitionTrade(f.db, t.id, { type: "agree", by: "seller", acceptedAt: new Date() });
  await f.db
    .update(trades)
    .set({ escrowAdmin: Keypair.random().publicKey(), escrowContractId: contractFor(t.id) })
    .where(eq(trades.id, t.id));
  await transitionTrade(f.db, t.id, { type: "escrowCreate", by: "seller", contractId: contractFor(t.id), txHash: HASH.create });
  return t;
}

async function fundedTrade(amount = "20", buyer = f.taker) {
  const t = await createdTrade(amount, buyer);
  await transitionTrade(f.db, t.id, { type: "fund", by: "seller", txHash: HASH.fund, fundedAt: new Date() });
  return t;
}

async function withChat(tradeId: string) {
  await f.db.insert(chatMessages).values([
    { tradeId, author: f.taker, body: "Meet at the station?" },
    { tradeId, author: f.owner, body: "See you at 3" },
  ]);
}

describe("transitionTrade, protected trades", () => {
  it("records the acceptance of the side that agrees, keeping the opener's", async () => {
    const t = await openProtectedTrade(f, "20");
    const acceptedAt = new Date("2026-11-24T10:00:00Z");
    await transitionTrade(f.db, t.id, { type: "agree", by: "seller", acceptedAt });
    expect(await row(t.id)).toMatchObject({ state: "agreed", sellerAcceptedAt: acceptedAt, buyerAcceptedAt: t.buyerAcceptedAt });
  });

  it("records the escrow and the fund with their transactions and the fund's ledger time", async () => {
    const t = await createdTrade();
    expect(await row(t.id)).toMatchObject({ state: "escrow_created", escrowContractId: contractFor(t.id), createTx: HASH.create });
    const fundedAt = new Date("2026-11-24T10:05:00Z");
    await transitionTrade(f.db, t.id, { type: "fund", by: "seller", txHash: HASH.fund, fundedAt });
    expect(await row(t.id)).toMatchObject({ state: "funded", fundTx: HASH.fund, fundedAt });
    const events = await f.db
      .select({ type: tradeEvents.type, by: tradeEvents.by, txHash: tradeEvents.txHash })
      .from(tradeEvents)
      .where(eq(tradeEvents.tradeId, t.id))
      .orderBy(asc(tradeEvents.createdAt));
    expect(events).toEqual([
      { type: "open", by: "buyer", txHash: null },
      { type: "agree", by: "seller", txHash: null },
      { type: "escrowCreate", by: "seller", txHash: HASH.create },
      { type: "fund", by: "seller", txHash: HASH.fund },
    ]);
  });

  it("records a dispute's ledger time, when Pairy recorded it and who opened it, and keeps the chat", async () => {
    const t = await fundedTrade();
    await withChat(t.id);
    const disputedAt = new Date(Date.now() - 2 * 3600_000);
    const before = Date.now();
    await transitionTrade(f.db, t.id, { type: "escrowDispute", by: "seller", txHash: HASH.dispute, disputedAt });
    const after = Date.now();
    const r = await row(t.id);
    expect(r).toMatchObject({ state: "funded", disputed: true, disputeTx: HASH.dispute, disputedAt, disputeOpenedBy: "seller" });
    expect(r.disputeRecordedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(r.disputeRecordedAt!.getTime()).toBeLessThanOrEqual(after);
    expect(await chatCount(t.id)).toBe(2);
  });

  it("deletes the chat and every note, keeping both answers, when the arbiter resolves", async () => {
    const t = await fundedTrade();
    const other = await fundedTrade("20", f.stranger);
    for (const id of [t.id, other.id]) {
      await withChat(id);
      await transitionTrade(f.db, id, { type: "escrowDispute", by: "buyer", txHash: HASH.dispute, disputedAt: new Date() });
      await f.db.insert(disputeAnswers).values([
        { tradeId: id, role: "seller", cashHandedOver: false, note: "No cash came." },
        { tradeId: id, role: "buyer", cashHandedOver: true, note: "I paid in full." },
      ]);
    }
    const resolvedAt = new Date("2026-11-25T10:00:00Z");
    await transitionTrade(f.db, t.id, { type: "resolve", by: "arbiter", outcome: "seller", txHash: HASH.resolve, resolvedAt });

    expect(await row(t.id)).toMatchObject({ state: "resolved_seller", resolveTx: HASH.resolve, resolvedAt });
    expect(await chatCount(t.id)).toBe(0);
    const answers = (id: string) =>
      f.db
        .select({ role: disputeAnswers.role, cashHandedOver: disputeAnswers.cashHandedOver, note: disputeAnswers.note })
        .from(disputeAnswers)
        .where(eq(disputeAnswers.tradeId, id))
        .orderBy(asc(disputeAnswers.role));
    expect(await answers(t.id)).toEqual([
      { role: "seller", cashHandedOver: false, note: null },
      { role: "buyer", cashHandedOver: true, note: null },
    ]);
    // The other trade is still disputed: its chat and notes stay.
    expect(await chatCount(other.id)).toBe(2);
    expect((await answers(other.id)).map((a) => a.note)).toEqual(["No cash came.", "I paid in full."]);
  });

  it("deletes the chat when the seller releases", async () => {
    const t = await fundedTrade();
    await withChat(t.id);
    await transitionTrade(f.db, t.id, { type: "release", by: "seller", txHash: HASH.release });
    expect(await row(t.id)).toMatchObject({ state: "released", releaseTx: HASH.release });
    expect(await chatCount(t.id)).toBe(0);
  });

  it("refuses a claimable event on a protected trade", async () => {
    const t = await createdTrade();
    await expect(
      transitionTrade(f.db, t.id, { type: "flagDispute", by: "buyer" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Cannot flagDispute a escrow_created trade: a protected trade settles through its escrow" });
    expect((await row(t.id)).disputed).toBe(false);
  });
});
