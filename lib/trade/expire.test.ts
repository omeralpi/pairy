import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { chatMessages, listings, tradeEvents, trades } from "@/lib/db/schema";
import { TW_ESCROW_WASM_HASH } from "@/lib/escrow/config";
import { EscrowNotFoundError, readEscrow, readWasmHash } from "@/lib/escrow/read";
import { expectedTerms } from "@/lib/escrow/terms";
import { findEscrowTx, verifyEscrowTx } from "@/lib/escrow/verify";
import { findClaimTx, findLockTx, verifyClaimTx } from "@/lib/stellar/verify";
import { TX, openProtectedTrade, tradeFixture } from "@/lib/trade/test-helpers";

import { IDLE_TRADE_MS, expireIdleTrades } from "./expire";

vi.mock("@/lib/stellar/verify", async (orig) => ({
  ...(await orig<typeof import("@/lib/stellar/verify")>()),
  verifyLockTx: vi.fn(),
  verifyClaimTx: vi.fn(),
  findLockTx: vi.fn(async () => null),
  findClaimTx: vi.fn(async () => null),
}));
vi.mock("@/lib/escrow/read", async (orig) => ({ ...(await orig<typeof import("@/lib/escrow/read")>()), readEscrow: vi.fn(), readWasmHash: vi.fn() }));
vi.mock("@/lib/escrow/verify", async (orig) => ({ ...(await orig<typeof import("@/lib/escrow/verify")>()), verifyEscrowTx: vi.fn(), findEscrowTx: vi.fn(async () => null) }));

const BALANCE = "00000000" + "e".repeat(64);
const DAY = 24 * 60 * 60 * 1000;
let f: Awaited<ReturnType<typeof tradeFixture>>;

beforeEach(async () => {
  vi.mocked(findLockTx).mockReset().mockResolvedValue(null);
  vi.mocked(findClaimTx).mockReset().mockResolvedValue(null);
  vi.mocked(readEscrow).mockReset().mockRejectedValue(new Error("readEscrow not set up for this test"));
  vi.mocked(readWasmHash).mockReset().mockResolvedValue(TW_ESCROW_WASM_HASH!);
  vi.mocked(findEscrowTx).mockReset().mockResolvedValue(null);
  vi.mocked(verifyEscrowTx).mockReset();
  f = await tradeFixture();
});

const open = () => f.as(f.taker).trade.open({ listingId: f.listing.id, amount: "25.5" });
/** Moves a trade's last activity back by `days`. */
const age = (id: string, days: number) =>
  f.db.update(trades).set({ updatedAt: new Date(Date.now() - days * DAY) }).where(eq(trades.id, id));
const state = async (id: string) => (await f.db.select().from(trades).where(eq(trades.id, id)))[0];
const chat = (id: string) => f.db.select().from(chatMessages).where(eq(chatMessages.tradeId, id));

describe("expireIdleTrades", () => {
  it("cancels a listed trade nobody touched for a week and deletes its chat", async () => {
    const t = await open();
    await f.as(f.taker).chat.send({ tradeId: t.id, body: "still there?" });
    await f.db.update(chatMessages).set({ createdAt: new Date(Date.now() - 8 * DAY) }).where(eq(chatMessages.tradeId, t.id));
    await age(t.id, 8);

    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 1 });
    expect((await state(t.id)).state).toBe("cancelled");
    expect(await chat(t.id)).toEqual([]);
    const events = await f.db.select().from(tradeEvents).where(eq(tradeEvents.tradeId, t.id));
    expect(events.at(-1)).toMatchObject({ type: "expire", by: "system" });
  });

  it("leaves a trade alone while its chat is still in use", async () => {
    const t = await open();
    await age(t.id, 8);
    await f.as(f.taker).chat.send({ tradeId: t.id, body: "on my way" });
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 0 });
    expect((await state(t.id)).state).toBe("listed");
  });

  it("leaves a trade alone before a week has passed", async () => {
    const t = await open();
    await age(t.id, IDLE_TRADE_MS / DAY - 1);
    await expireIdleTrades(f.db);
    expect((await state(t.id)).state).toBe("listed");
  });

  it("records a lock found on the ledger instead of cancelling an agreed trade", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await age(t.id, 8);
    vi.mocked(findLockTx).mockResolvedValueOnce({ hash: TX.lock, balanceId: BALANCE, createdAt: new Date() });
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 0 });
    expect((await state(t.id)).state).toBe("locked");
  });

  it("skips an agreed trade when Stellar cannot be checked, rather than cancelling over a possible lock", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await age(t.id, 8);
    vi.mocked(findLockTx).mockRejectedValueOnce(new Error("Request failed with status code 503"));
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 0, skipped: 1 });
    expect((await state(t.id)).state).toBe("agreed");
  });

  it("deletes the chat of a locked trade a week after the buyer's claim window closed, leaving the money to the chain", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await f.db
      .update(trades)
      .set({ state: "locked", balanceId: BALANCE, lockTx: TX.lock, lockedAt: new Date(Date.now() - 11 * DAY) })
      .where(eq(trades.id, t.id));
    await f.as(f.taker).chat.send({ tradeId: t.id, body: "see you" });

    expect(await expireIdleTrades(f.db)).toMatchObject({ purged: 1 });
    expect(await chat(t.id)).toEqual([]);
    expect((await state(t.id)).state).toBe("locked");
  });

  it("keeps the chat of a locked trade whose window closed less than a week ago", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await f.db
      .update(trades)
      .set({ state: "locked", balanceId: BALANCE, lockTx: TX.lock, lockedAt: new Date(Date.now() - 5 * DAY) })
      .where(eq(trades.id, t.id));
    await f.as(f.taker).chat.send({ tradeId: t.id, body: "see you" });
    await expireIdleTrades(f.db);
    expect(await chat(t.id)).toHaveLength(1);
  });

  it("keeps reaching new locked trades when older abandoned ones (chat already gone) pile up (RF-1)", async () => {
    const base = {
      listingId: f.listing.id,
      seller: f.owner,
      buyer: f.taker,
      openedBy: "buyer" as const,
      asset: "XLM" as const,
      amount: "25.5",
      fiatCode: "TRY",
      fiatAmount: "105.19",
      state: "locked" as const,
      windowSeconds: 259_200,
      lockTx: TX.lock,
    };
    for (let i = 0; i < 26; i++) {
      await f.db.insert(trades).values({
        ...base,
        balanceId: "00000000" + i.toString(16).padStart(64, "0"),
        lockedAt: new Date(Date.now() - 60 * DAY),
        updatedAt: new Date(Date.now() - 60 * DAY + i * 1000),
      });
    }
    const [t] = await f.db
      .insert(trades)
      .values({ ...base, balanceId: BALANCE, lockedAt: new Date(Date.now() - 14 * DAY), updatedAt: new Date(Date.now() - 14 * DAY) })
      .returning();
    await f.db.insert(chatMessages).values({ tradeId: t.id, author: f.taker, body: "see you" });
    await expireIdleTrades(f.db);
    expect(await chat(t.id)).toEqual([]);
  });

  it("records a claim found on the ledger rather than only purging a stale locked trade", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await f.db
      .update(trades)
      .set({ state: "locked", balanceId: BALANCE, lockTx: TX.lock, lockedAt: new Date(Date.now() - 11 * DAY) })
      .where(eq(trades.id, t.id));
    await f.as(f.taker).chat.send({ tradeId: t.id, body: "see you" });
    vi.mocked(findClaimTx).mockResolvedValueOnce(TX.claim);
    vi.mocked(verifyClaimTx).mockResolvedValueOnce({ claimant: f.taker });
    await expireIdleTrades(f.db);
    expect((await state(t.id)).state).toBe("claimed");
  });

  it("never touches a flagged trade: its chat is the evidence an arbiter would need", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await f.as(f.taker).chat.send({ tradeId: t.id, body: "he took my cash and never locked" });
    await f.as(f.taker).trade.flagDispute({ tradeId: t.id });
    await f.db.update(chatMessages).set({ createdAt: new Date(Date.now() - 8 * DAY) }).where(eq(chatMessages.tradeId, t.id));
    await age(t.id, 8);
    await expireIdleTrades(f.db);
    expect((await state(t.id)).state).toBe("agreed");
    expect(await chat(t.id)).toHaveLength(1);
  });

  it("leaves two agreed trades with the same terms alone: a lock on chain could belong to either", async () => {
    const a = await open();
    const b = await open();
    for (const t of [a, b]) {
      await f.as(f.owner).trade.agree({ tradeId: t.id });
      await age(t.id, 8);
    }
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 0 });
    expect((await state(a.id)).state).toBe("agreed");
    expect((await state(b.id)).state).toBe("agreed");
  });

  it("does not retry the same failing agreed trades first every day", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await age(t.id, 8);
    vi.mocked(findLockTx).mockRejectedValueOnce(new Error("503"));
    await expireIdleTrades(f.db);
    // Skipped trades go to the back of the queue.
    expect((await state(t.id)).lastSyncedAt).not.toBeNull();
  });
});

describe("expireIdleTrades: protected trades", () => {
  const ADMIN = Keypair.random().publicKey();
  const newEscrowId = () => StrKey.encodeContract(Keypair.random().rawPublicKey());

  /** A protected 20 USDC trade on a USDC listing of the owner's, written straight into `values`, idle for 8 days. */
  async function protectedTrade(values: Partial<typeof trades.$inferInsert>) {
    const [usdc] = await f.db.insert(listings).values({ ...f.listing, id: undefined, asset: "USDC" }).returning();
    const t = await openProtectedTrade({ ...f, listing: usdc }, "20");
    await f.db
      .update(trades)
      .set({ state: "agreed", sellerAcceptedAt: new Date(), escrowAdmin: ADMIN, escrowContractId: newEscrowId(), escrowPreparedAt: new Date(Date.now() - 8 * DAY), ...values })
      .where(eq(trades.id, t.id));
    await age(t.id, 8);
    return state(t.id);
  }
  const createdValues = () => ({ state: "escrow_created" as const, createTx: "1".repeat(64) });
  const fundedValues = () => ({ ...createdValues(), state: "funded" as const, fundTx: "2".repeat(64), fundedAt: new Date(Date.now() - 8 * DAY) });
  const left = async (id: string) => (await f.db.select().from(listings).where(eq(listings.id, (await state(id)).listingId)))[0].remainingAmount;

  /** What Soroban RPC shows for every escrow. */
  function chainShows(status: { disputed?: boolean; released?: boolean; resolved?: boolean; balanceStroops?: bigint } | null) {
    vi.mocked(readEscrow).mockImplementation(async (id) => {
      if (!status) throw new EscrowNotFoundError(id);
      return {
        terms: expectedTerms({ buyer: f.taker, seller: f.owner, amount: "20", escrowAdmin: ADMIN }),
        status: { disputed: false, released: false, resolved: false, balanceStroops: 0n, ...status },
        ttl: { latestLedger: 5_900_000, instanceLiveUntil: 6_018_006, escrowLiveUntil: 6_018_006 },
      };
    });
  }

  it("cancels an idle created escrow that holds nothing, after reading it, and gives the amount back", async () => {
    const t = await protectedTrade(createdValues());
    chainShows({ balanceStroops: 0n });
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 1 });
    expect((await state(t.id)).state).toBe("cancelled");
    expect(readEscrow).toHaveBeenCalledWith(t.escrowContractId);
    expect(await left(t.id)).toBe("100.0000000");
  });

  it("records a fund found on chain instead of expiring a created escrow", async () => {
    const t = await protectedTrade(createdValues());
    chainShows({ balanceStroops: 200_000_000n });
    vi.mocked(findEscrowTx).mockResolvedValue("2".repeat(64));
    vi.mocked(verifyEscrowTx).mockResolvedValue({ createdAt: new Date(), signer: f.owner, contractId: t.escrowContractId!, transfers: [] });
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 0 });
    expect((await state(t.id)).state).toBe("funded");
  });

  it("skips a created escrow whose USDC is on chain while its fund cannot be placed yet, or that cannot be read", async () => {
    const t = await protectedTrade(createdValues());
    chainShows({ balanceStroops: 200_000_000n });
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 0, skipped: 1 });
    vi.mocked(readEscrow).mockRejectedValue(new Error("fetch failed"));
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 0, skipped: 1 });
    expect((await state(t.id)).state).toBe("escrow_created");
  });

  it("expires an idle agreed trade with a prepared creation only once Soroban RPC shows no contract, and records one that landed (O-23)", async () => {
    const gone = await protectedTrade({});
    chainShows(null);
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 1 });
    expect((await state(gone.id)).state).toBe("cancelled");

    const landed = await protectedTrade({});
    chainShows({ balanceStroops: 0n });
    vi.mocked(findEscrowTx).mockResolvedValue("1".repeat(64));
    vi.mocked(verifyEscrowTx).mockResolvedValue({ createdAt: new Date(), signer: ADMIN, contractId: landed.escrowContractId!, transfers: [] });
    await expireIdleTrades(f.db);
    // Recorded first; then, holding nothing, it ends like any idle created escrow.
    const events = (await f.db.select().from(tradeEvents).where(eq(tradeEvents.tradeId, landed.id))).map((e) => e.type);
    expect(events.slice(-2)).toEqual(["escrowCreate", "expire"]);
  });

  it("never expires a funded trade, however long it idles", async () => {
    const t = await protectedTrade({ ...fundedValues() });
    await age(t.id, 60);
    chainShows({ balanceStroops: 200_000_000n });
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 0 });
    expect((await state(t.id)).state).toBe("funded");
  });

  it("syncs at most 10 funded protected trades a run, least recently synced first, recording what the chain shows (F-12)", async () => {
    const funded = [];
    for (let i = 0; i < 11; i++) {
      // One never synced, then the others synced 11, 10, … 1 hours ago.
      funded.push(await protectedTrade({ ...fundedValues(), lastSyncedAt: i === 0 ? null : new Date(Date.now() - (12 - i) * 3600_000) }));
    }
    chainShows({ disputed: true, balanceStroops: 200_000_000n });
    vi.mocked(findEscrowTx).mockImplementation(async (account, _c, fn) => (account === f.taker && fn === "dispute_escrow" ? "3".repeat(64) : null));
    vi.mocked(verifyEscrowTx).mockImplementation(async (_h, e) => ({ createdAt: new Date(Date.now() - DAY), signer: f.taker, contractId: e.contractId, transfers: [] }));
    const before = Date.now();
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 0, synced: 10 });
    const after = await Promise.all(funded.map((t) => state(t.id)));
    expect(after.map((t) => t.disputed)).toEqual([...Array(10).fill(true), false]);
    expect(after.slice(0, 10).every((t) => t.lastSyncedAt!.getTime() >= before)).toBe(true);
    // Each found dispute starts its window now, when Pairy recorded it.
    expect(after[0].disputeRecordedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });
});
