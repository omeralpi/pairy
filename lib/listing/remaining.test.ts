// SOW D3: a listing's remaining amount is reserved when a trade opens, given
// back when the trade is cancelled, expired, reset or reclaimed, and used up
// when it is claimed. The column is recomputed from the listing's trades on
// every transition (DECISIONS 2), so every rule below falls out of one sum.

import { Keypair } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listings, trades } from "@/lib/db/schema";
import { loadAccount } from "@/lib/stellar/horizon";
import { findClaimTx, findLockTx, verifyClaimTx, verifyLockTx } from "@/lib/stellar/verify";
import { expireIdleTrades } from "@/lib/trade/expire";
import { transitionTrade } from "@/lib/trade/persist";
import { TX, openProtectedTrade, tradeFixture } from "@/lib/trade/test-helpers";
import { closeResetTrades } from "@/lib/trade/testnet-reset";

vi.mock("@/lib/stellar/verify", async (orig) => ({
  ...(await orig<typeof import("@/lib/stellar/verify")>()),
  verifyLockTx: vi.fn(),
  verifyClaimTx: vi.fn(),
  findLockTx: vi.fn(async () => null),
  findClaimTx: vi.fn(async () => null),
}));
vi.mock("@/lib/stellar/horizon", async (orig) => ({
  ...(await orig<typeof import("@/lib/stellar/horizon")>()),
  loadAccount: vi.fn(async () => null),
}));

const BALANCE = "00000000" + "a".repeat(64);
const DAY = 24 * 60 * 60 * 1000;
let f: Awaited<ReturnType<typeof tradeFixture>>;

beforeEach(async () => {
  vi.mocked(verifyLockTx).mockReset().mockResolvedValue({ balanceId: BALANCE, createdAt: new Date() });
  vi.mocked(verifyClaimTx).mockReset();
  vi.mocked(findLockTx).mockReset().mockResolvedValue(null);
  vi.mocked(findClaimTx).mockReset().mockResolvedValue(null);
  vi.mocked(loadAccount).mockReset().mockResolvedValue(null);
  f = await tradeFixture();
});

const open = (amount: string, buyer = f.taker) => f.as(buyer).trade.open({ listingId: f.listing.id, amount });
/** What the listing shows as left, through the same read the UI uses. */
const left = async () => (await f.as(null).listing.byId({ id: f.listing.id })).remainingAmount;

async function locked(amount: string) {
  const t = await open(amount);
  await f.as(f.owner).trade.agree({ tradeId: t.id });
  await f.as(f.owner).trade.recordLock({ tradeId: t.id, txHash: TX.lock });
  return t;
}

describe("remaining amount", () => {
  it("starts at the maximum and is reserved when a trade opens", async () => {
    expect(await left()).toBe("100.0000000");
    await open("60");
    expect(await left()).toBe("40.0000000");
  });

  it("stays reserved through agree and lock", async () => {
    const t = await open("60");
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    expect(await left()).toBe("40.0000000");
    await f.as(f.owner).trade.recordLock({ tradeId: t.id, txHash: TX.lock });
    expect(await left()).toBe("40.0000000");
  });

  it("is given back when the trade is cancelled", async () => {
    const t = await open("60");
    await f.as(f.owner).trade.cancel({ tradeId: t.id });
    expect(await left()).toBe("100.0000000");
  });

  it("is given back when the daily cleanup expires the trade", async () => {
    const t = await open("60");
    await f.db.update(trades).set({ updatedAt: new Date(Date.now() - 8 * DAY) }).where(eq(trades.id, t.id));
    expect(await expireIdleTrades(f.db)).toMatchObject({ expired: 1 });
    expect(await left()).toBe("100.0000000");
  });

  it("is given back when a testnet reset closes the trade", async () => {
    await open("60");
    expect(await closeResetTrades(f.db, { apply: true, before: new Date(Date.now() + 60_000) })).toHaveLength(1);
    expect(await left()).toBe("100.0000000");
  });

  it("is given back when the seller reclaims the lock", async () => {
    const t = await locked("60");
    vi.mocked(verifyClaimTx).mockResolvedValue({ claimant: f.owner });
    await f.as(f.owner).trade.recordClaim({ tradeId: t.id, txHash: TX.reclaim });
    expect(await left()).toBe("100.0000000");
  });

  it("is used up when the buyer claims", async () => {
    const t = await locked("60");
    vi.mocked(verifyClaimTx).mockResolvedValue({ claimant: f.taker });
    await f.as(f.taker).trade.recordClaim({ tradeId: t.id, txHash: TX.claim });
    expect(await left()).toBe("40.0000000");
  });

  it("refuses a trade for more than is left, naming what is left", async () => {
    await open("60");
    await expect(open("50", f.stranger)).rejects.toThrow("Only 40 XLM left on this listing. Enter 10 to 40.");
    expect((await open("40", f.stranger)).state).toBe("listed");
  });

  it("refuses every trade once less than the minimum is left", async () => {
    await open("95");
    await expect(open("10", f.stranger)).rejects.toThrow(
      "This listing has less than its minimum left, so it isn't taking trades right now.",
    );
    expect(await left()).toBe("5.0000000");
  });

  it("never changes the listing's status: a paused listing stays paused after a give-back", async () => {
    const t = await open("100");
    await f.as(f.owner).listing.setStatus({ id: f.listing.id, status: "paused" });
    await f.as(f.owner).trade.cancel({ tradeId: t.id });
    const [row] = await f.db.select().from(listings).where(eq(listings.id, f.listing.id));
    expect(row).toMatchObject({ status: "paused", remainingAmount: "100.0000000" });
  });

  // An incremental counter drifts here: it would give back on A's reclaim an
  // amount it never took when A's lock was clamped, and the listing would
  // offer 100 while B still holds 100.
  it("chain wins: a lock found on a cancelled trade clamps at 0 and its reclaim gives nothing back while another trade holds the amount", async () => {
    const a = await open("100");
    await f.as(f.owner).trade.agree({ tradeId: a.id });
    await f.as(f.taker).trade.cancel({ tradeId: a.id });
    expect(await left()).toBe("100.0000000");

    const b = await open("100", f.stranger);
    expect(b.state).toBe("listed");
    expect(await left()).toBe("0.0000000");

    vi.mocked(findLockTx).mockResolvedValueOnce({ hash: TX.lock, balanceId: BALANCE, createdAt: new Date() });
    expect((await f.as(f.owner).trade.sync({ tradeId: a.id })).state).toBe("locked");
    expect(await left()).toBe("0.0000000");

    vi.mocked(verifyClaimTx).mockResolvedValue({ claimant: f.owner });
    expect((await f.as(f.owner).trade.recordClaim({ tradeId: a.id, txHash: TX.reclaim })).state).toBe("reclaimed");
    expect(await left()).toBe("0.0000000");
  });
});

// Protected trades (D2 §4): an escrow that holds or paid out the amount counts
// against the listing like a lock or a claim; the arbiter's refund to the
// seller gives the full gross amount back.
describe("remaining amount, protected trades", () => {
  let p: Awaited<ReturnType<typeof tradeFixture>>;
  beforeEach(async () => {
    p = await tradeFixture("sell_crypto", "USDC");
  });

  const leftOnUsdc = async () => (await p.as(null).listing.byId({ id: p.listing.id })).remainingAmount;
  const now = () => new Date();
  const agree = (id: string) => transitionTrade(p.db, id, { type: "agree", by: "seller", acceptedAt: now() });
  /** prepareCreate stores the admin and the contract id (WP-24); the deploy then lands. */
  async function create(id: string) {
    const contractId = `C${id.replace(/-/g, "").toUpperCase().padEnd(55, "A")}`;
    await p.db.update(trades).set({ escrowAdmin: Keypair.random().publicKey(), escrowContractId: contractId }).where(eq(trades.id, id));
    return transitionTrade(p.db, id, { type: "escrowCreate", by: "seller", contractId, txHash: "d".repeat(64) });
  }
  const fund = (id: string, reconcile?: boolean) =>
    transitionTrade(p.db, id, { type: "fund", by: "seller", txHash: "e".repeat(64), fundedAt: now(), reconcile });
  const dispute = (id: string) =>
    transitionTrade(p.db, id, { type: "escrowDispute", by: "buyer", txHash: "f".repeat(64), disputedAt: now() });
  const resolve = (id: string, outcome: "buyer" | "seller") =>
    transitionTrade(p.db, id, { type: "resolve", by: "arbiter", outcome, txHash: "9".repeat(64), resolvedAt: now() });
  async function fundedTrade(amount: string, buyer = p.taker) {
    const t = await openProtectedTrade(p, amount, buyer);
    await agree(t.id);
    await create(t.id);
    await fund(t.id);
    return t;
  }

  it("stays reserved through agree, escrow_created and funded, and is used up on release", async () => {
    const t = await openProtectedTrade(p, "60");
    expect(await leftOnUsdc()).toBe("40.0000000");
    await agree(t.id);
    expect(await leftOnUsdc()).toBe("40.0000000");
    expect((await create(t.id)).state).toBe("escrow_created");
    expect(await leftOnUsdc()).toBe("40.0000000");
    expect((await fund(t.id)).state).toBe("funded");
    expect(await leftOnUsdc()).toBe("40.0000000");
    expect((await transitionTrade(p.db, t.id, { type: "release", by: "seller", txHash: "1".repeat(64) })).state).toBe("released");
    expect(await leftOnUsdc()).toBe("40.0000000");
  });

  it("is used up when the arbiter pays the buyer and given back in full when it refunds the seller", async () => {
    const a = await fundedTrade("30");
    const b = await fundedTrade("50", p.stranger);
    await dispute(a.id);
    await dispute(b.id);
    expect(await leftOnUsdc()).toBe("20.0000000");
    expect((await resolve(a.id, "buyer")).state).toBe("resolved_buyer");
    expect(await leftOnUsdc()).toBe("20.0000000");
    expect((await resolve(b.id, "seller")).state).toBe("resolved_seller");
    expect(await leftOnUsdc()).toBe("70.0000000");
  });

  it("is given back when an unfunded escrow is cancelled, and a fund found after the cancel takes it again, clamped at 0 (chain wins)", async () => {
    const a = await openProtectedTrade(p, "100");
    await agree(a.id);
    await create(a.id);
    await transitionTrade(p.db, a.id, { type: "cancel", by: "buyer" });
    expect(await leftOnUsdc()).toBe("100.0000000");

    const b = await openProtectedTrade(p, "100", p.stranger);
    expect(await leftOnUsdc()).toBe("0.0000000");
    expect((await fund(a.id, true)).state).toBe("funded");
    expect(await leftOnUsdc()).toBe("0.0000000");
    await transitionTrade(p.db, b.id, { type: "cancel", by: "buyer" });
    expect(await leftOnUsdc()).toBe("0.0000000");
  });
});
