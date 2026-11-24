import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listings, tradeEvents, trades } from "@/lib/db/schema";
import { ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { horizon, loadAccount } from "@/lib/stellar/horizon";
import { LockMismatchError, findClaimTx, findLockTx, verifyClaimTx, verifyLockTx } from "@/lib/stellar/verify";
import { TX, tradeFixture } from "@/lib/trade/test-helpers";
import { isArbiterSigner } from "@/server/api/arbiter-auth";

vi.mock("@/lib/stellar/verify", async (orig) => ({
  // The real error classes, so verification messages reach the caller as they would.
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
vi.mock("@/server/api/arbiter-auth", async (orig) => ({
  ...(await orig<typeof import("@/server/api/arbiter-auth")>()),
  isArbiterSigner: vi.fn(async () => false),
}));

const BALANCE = "00000000" + "d".repeat(64);
const LOCKED_AT = new Date("2026-10-16T12:00:00Z");

let f: Awaited<ReturnType<typeof tradeFixture>>;

beforeEach(async () => {
  vi.mocked(verifyLockTx).mockReset().mockResolvedValue({ balanceId: BALANCE, createdAt: LOCKED_AT });
  vi.mocked(verifyClaimTx).mockReset();
  vi.mocked(findLockTx).mockReset().mockResolvedValue(null);
  vi.mocked(findClaimTx).mockReset().mockResolvedValue(null);
  f = await tradeFixture();
});

/** sell_crypto listing: owner = seller, taker = buyer (and the opener). */
async function openTrade(amount = "25.5") {
  return f.as(f.taker).trade.open({ listingId: f.listing.id, amount });
}

async function lockedTrade() {
  const t = await openTrade();
  await f.as(f.owner).trade.agree({ tradeId: t.id });
  await f.as(f.owner).trade.recordLock({ tradeId: t.id, txHash: TX.lock });
  return t;
}

describe("trade.open", () => {
  it("assigns roles from the listing side and prices the fiat leg", async () => {
    const t = await openTrade();
    expect(t).toMatchObject({
      seller: f.owner,
      buyer: f.taker,
      openedBy: "buyer",
      state: "listed",
      amount: "25.5000000",
      fiatCode: "TRY",
      fiatAmount: "105.19", // 25.5 × 4.125 = 105.1875
      windowSeconds: 259_200,
    });
  });

  it("makes the listing owner the buyer on a buy_crypto listing", async () => {
    f = await tradeFixture("buy_crypto");
    const t = await openTrade();
    expect(t).toMatchObject({ seller: f.taker, buyer: f.owner, openedBy: "seller" });
  });

  it("enforces the listing's amount bounds", async () => {
    await expect(openTrade("9.9999999")).rejects.toThrow(/between 10 and 100 XLM/);
    await expect(openTrade("100.0000001")).rejects.toThrow(/between 10 and 100 XLM/);
    await expect(openTrade("0")).rejects.toThrow();
    await expect(openTrade("1.12345678")).rejects.toThrow();
    const ten = await openTrade("10");
    expect(ten.state).toBe("listed");
    // The 10 is reserved until it is cancelled; only then is the whole 100 open again.
    await f.as(f.owner).trade.cancel({ tradeId: ten.id });
    expect((await openTrade("100")).state).toBe("listed");
  });

  it("rejects an amount whose cash leg rounds to nothing (Q-27)", async () => {
    await f.db.update(listings).set({ minAmount: "0.0000001", rate: "0.0001" }).where(eq(listings.id, f.listing.id));
    await expect(openTrade("1")).rejects.toThrow(/at least 0.01 TRY/);
    expect((await openTrade("50")).fiatAmount).toBe("0.01");
  });

  it("caps how many unfinished trades one account can open (RR2-4)", async () => {
    const opened = [];
    for (let i = 0; i < 5; i++) opened.push(await openTrade("10"));
    await expect(openTrade("10")).rejects.toThrow(/5 open trades/);
    await f.as(f.owner).trade.cancel({ tradeId: opened[0].id });
    expect((await openTrade("10")).state).toBe("listed");
  });

  it("rejects trading on your own listing, inactive listings and anonymous callers", async () => {
    await expect(f.as(f.owner).trade.open({ listingId: f.listing.id, amount: "20" })).rejects.toThrow(
      /own listing/,
    );
    await expect(f.as(null).trade.open({ listingId: f.listing.id, amount: "20" })).rejects.toThrow(
      /UNAUTHORIZED/,
    );
    await f.as(f.owner).listing.setStatus({ id: f.listing.id, status: "paused" });
    await expect(openTrade()).rejects.toThrow(/not available/);
  });
});

describe("trade flow", () => {
  it("runs the happy path listed → agreed → locked → claimed, verifying every hash", async () => {
    const t = await openTrade();
    expect((await f.as(f.owner).trade.agree({ tradeId: t.id })).state).toBe("agreed");

    const locked = await f.as(f.owner).trade.recordLock({ tradeId: t.id, txHash: TX.lock });
    expect(locked).toMatchObject({ state: "locked", balanceId: BALANCE, lockTx: TX.lock });
    expect(verifyLockTx).toHaveBeenCalledWith(TX.lock, {
      seller: f.owner,
      buyer: f.taker,
      asset: "XLM",
      amount: "25.5000000",
      windowSeconds: 259_200,
      // Older locks with the same parties and amount must not count.
      notBefore: t.createdAt,
    });

    vi.mocked(verifyClaimTx).mockResolvedValue({ claimant: f.taker });
    const claimed = await f.as(f.taker).trade.recordClaim({ tradeId: t.id, txHash: TX.claim });
    expect(claimed).toMatchObject({ state: "claimed", claimTx: TX.claim });
    expect(verifyClaimTx).toHaveBeenCalledWith(TX.claim, BALANCE);

    const room = await f.as(f.taker).trade.byId({ id: t.id });
    expect(room.role).toBe("buyer");
    // The listing's own rate, not one worked back from the rounded cash total (105.19 / 25.5 = 4.1251).
    expect(room.rate).toBe("4.1250");
    expect(room.counterparty).toBe(f.owner);
    expect(room.events.map((e) => [e.type, e.by])).toEqual([
      ["open", "buyer"],
      ["agree", "seller"],
      ["lock", "seller"],
      ["claim", "buyer"],
    ]);
    expect(room.events[2].txUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${TX.lock}`);
  });

  it("records a reclaim when the chain says the seller claimed", async () => {
    const t = await lockedTrade();
    vi.mocked(verifyClaimTx).mockResolvedValue({ claimant: f.owner });
    const done = await f.as(f.owner).trade.recordClaim({ tradeId: t.id, txHash: TX.reclaim });
    expect(done).toMatchObject({ state: "reclaimed", reclaimTx: TX.reclaim, claimTx: null });
  });

  it("never changes state when verification fails", async () => {
    const t = await openTrade();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    vi.mocked(verifyLockTx).mockRejectedValue(new LockMismatchError("The lock in x is not in XLM."));
    await expect(f.as(f.owner).trade.recordLock({ tradeId: t.id, txHash: TX.lock })).rejects.toThrow(
      /not in XLM/,
    );
    expect((await f.as(f.owner).trade.byId({ id: t.id })).state).toBe("agreed");
  });

  it("rejects a claim by an account outside the trade", async () => {
    const t = await lockedTrade();
    vi.mocked(verifyClaimTx).mockResolvedValue({ claimant: f.stranger });
    await expect(f.as(f.taker).trade.recordClaim({ tradeId: t.id, txHash: TX.claim })).rejects.toThrow(
      /not part of this trade/,
    );
  });

  it("will not reuse one on-chain lock for a second trade", async () => {
    await lockedTrade();
    const second = await openTrade();
    await f.as(f.owner).trade.agree({ tradeId: second.id });
    await expect(
      f.as(f.owner).trade.recordLock({ tradeId: second.id, txHash: TX.lock }),
    ).rejects.toThrow(/another trade/);
  });
});

describe("role and state rules", () => {
  it("does not let the opener agree to their own trade", async () => {
    const t = await openTrade();
    await expect(f.as(f.taker).trade.agree({ tradeId: t.id })).rejects.toThrow(/cannot agree/);
  });

  it("only records a lock on an agreed trade", async () => {
    const t = await openTrade();
    await expect(f.as(f.owner).trade.recordLock({ tradeId: t.id, txHash: TX.lock })).rejects.toThrow(
      /only an agreed trade can be locked/,
    );
  });

  it("rejects a claim before the trade is locked", async () => {
    const t = await openTrade();
    await expect(f.as(f.taker).trade.recordClaim({ tradeId: t.id, txHash: TX.claim })).rejects.toThrow(
      /not been locked/,
    );
    expect(verifyClaimTx).not.toHaveBeenCalled();
  });

  it("rejects cancel once locked, for both parties", async () => {
    const t = await lockedTrade();
    for (const who of [f.owner, f.taker]) {
      await expect(f.as(who).trade.cancel({ tradeId: t.id })).rejects.toThrow(/only ways out are claim and reclaim/);
    }
    expect((await f.as(f.owner).trade.byId({ id: t.id })).state).toBe("locked");
  });

  it("refuses to cancel an agreed trade once the seller's lock is on the ledger", async () => {
    // The buyer cancels while the seller's lock is landing: the chain would
    // hold a live lock that the app shows as cancelled.
    const t = await openTrade();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    vi.mocked(findLockTx).mockResolvedValueOnce({ hash: TX.lock, balanceId: BALANCE, createdAt: LOCKED_AT });
    await expect(f.as(f.taker).trade.cancel({ tradeId: t.id })).rejects.toThrow(/already locked/);
    // The lock it found is recorded, so the page shows the truth.
    expect(await f.as(f.taker).trade.byId({ id: t.id })).toMatchObject({ state: "locked", balanceId: BALANCE });
  });

  it("lets either party cancel before the lock", async () => {
    const a = await openTrade();
    expect((await f.as(f.owner).trade.cancel({ tradeId: a.id })).state).toBe("cancelled");
    const b = await openTrade();
    await f.as(f.owner).trade.agree({ tradeId: b.id });
    expect((await f.as(f.taker).trade.cancel({ tradeId: b.id })).state).toBe("cancelled");
  });

  it("records a dispute flag without changing state, and the claim still goes through", async () => {
    const t = await lockedTrade();
    const flagged = await f.as(f.taker).trade.flagDispute({ tradeId: t.id });
    expect(flagged).toMatchObject({ state: "locked", disputed: true });
    const events = await f.db.select().from(tradeEvents).where(eq(tradeEvents.tradeId, t.id));
    expect(events.at(-1)).toMatchObject({ type: "flagDispute", by: "buyer" });

    vi.mocked(verifyClaimTx).mockResolvedValue({ claimant: f.taker });
    expect((await f.as(f.taker).trade.recordClaim({ tradeId: t.id, txHash: TX.claim })).state).toBe("claimed");
  });

  it("hides the trade from non-participants on every procedure", async () => {
    const t = await openTrade();
    const s = f.as(f.stranger);
    const id = { tradeId: t.id };
    await expect(s.trade.byId({ id: t.id })).rejects.toThrow(/Trade not found/);
    await expect(s.trade.agree(id)).rejects.toThrow(/Trade not found/);
    await expect(s.trade.cancel(id)).rejects.toThrow(/Trade not found/);
    await expect(s.trade.flagDispute(id)).rejects.toThrow(/Trade not found/);
    await expect(s.trade.lockPreflight(id)).rejects.toThrow(/Trade not found/);
    await expect(s.trade.recordLock({ ...id, txHash: TX.lock })).rejects.toThrow(/Trade not found/);
    await expect(s.trade.recordClaim({ ...id, txHash: TX.claim })).rejects.toThrow(/Trade not found/);
    await expect(s.trade.claimWindow(id)).rejects.toThrow(/Trade not found/);
    expect(await s.trade.mine()).toEqual([]);
    expect(verifyLockTx).not.toHaveBeenCalled();
  });

  it("lists my trades from both sides", async () => {
    const t = await openTrade();
    expect((await f.as(f.owner).trade.mine()).map((x) => [x.id, x.role, x.cityName])).toEqual([
      [t.id, "seller", "Istanbul"],
    ]);
    expect((await f.as(f.taker).trade.mine())[0]).toMatchObject({ role: "buyer", counterparty: f.owner });
  });
});

describe("trade.sync: the chain outranks the app's record", () => {
  it("records a lock that landed but was never reported (Q-1, T-2)", async () => {
    const t = await openTrade();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    vi.mocked(findLockTx).mockResolvedValueOnce({ hash: TX.lock, balanceId: BALANCE, createdAt: LOCKED_AT });
    const synced = await f.as(f.taker).trade.sync({ tradeId: t.id });
    expect(synced).toMatchObject({ state: "locked", balanceId: BALANCE, lockTx: TX.lock });
    expect(findLockTx).toHaveBeenCalledWith(
      expect.objectContaining({ seller: f.owner, buyer: f.taker, notBefore: t.createdAt }),
      new Set(),
    );
  });

  it("does not pick up a lock that already backs another trade", async () => {
    await lockedTrade();
    const second = await openTrade();
    await f.as(f.owner).trade.agree({ tradeId: second.id });
    await f.as(f.owner).trade.sync({ tradeId: second.id });
    expect(findLockTx).toHaveBeenLastCalledWith(expect.anything(), new Set([BALANCE]));
  });

  it("records a claim that was never reported and purges the chat (Q-2, T-3)", async () => {
    const t = await lockedTrade();
    await f.as(f.taker).chat.send({ tradeId: t.id, body: "on my way" });
    vi.mocked(findClaimTx).mockResolvedValueOnce(TX.claim);
    vi.mocked(verifyClaimTx).mockResolvedValue({ claimant: f.taker });
    const synced = await f.as(f.owner).trade.sync({ tradeId: t.id });
    expect(synced).toMatchObject({ state: "claimed", claimTx: TX.claim });
    expect(findClaimTx).toHaveBeenCalledWith(BALANCE);
    expect(await f.as(f.owner).chat.list({ tradeId: t.id })).toEqual([]);
  });

  it("records a lock and its reclaim on a trade the app had as cancelled", async () => {
    const t = await openTrade();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await f.as(f.taker).trade.cancel({ tradeId: t.id });
    vi.mocked(findLockTx).mockResolvedValueOnce({ hash: TX.lock, balanceId: BALANCE, createdAt: LOCKED_AT });
    vi.mocked(findClaimTx).mockResolvedValueOnce(TX.reclaim);
    vi.mocked(verifyClaimTx).mockResolvedValue({ claimant: f.owner });
    expect(await f.as(f.owner).trade.sync({ tradeId: t.id })).toMatchObject({
      state: "reclaimed",
      balanceId: BALANCE,
      reclaimTx: TX.reclaim,
    });
  });

  it("leaves the trade alone when the chain has nothing new", async () => {
    const t = await openTrade();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    expect((await f.as(f.owner).trade.sync({ tradeId: t.id })).state).toBe("agreed");
    expect(verifyClaimTx).not.toHaveBeenCalled();
  });

  it("hides the trade from non-participants", async () => {
    const t = await openTrade();
    await expect(f.as(f.stranger).trade.sync({ tradeId: t.id })).rejects.toThrow(/Trade not found/);
    expect(findLockTx).not.toHaveBeenCalled();
  });
});

describe("locks that race the app (T-1, Q-3, T-4, S-1)", () => {
  it("records a lock reported after the buyer cancelled", async () => {
    const t = await openTrade();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await f.as(f.taker).trade.cancel({ tradeId: t.id });
    const locked = await f.as(f.owner).trade.recordLock({ tradeId: t.id, txHash: TX.lock });
    expect(locked).toMatchObject({ state: "locked", balanceId: BALANCE });
  });

  it("tells the seller in preflight that the trade is already locked", async () => {
    const t = await openTrade();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    vi.mocked(findLockTx).mockResolvedValueOnce({ hash: TX.lock, balanceId: BALANCE, createdAt: LOCKED_AT });
    const pre = await f.as(f.owner).trade.lockPreflight({ tradeId: t.id });
    expect(pre.ok).toBe(false);
    expect(pre.checks[0]).toMatchObject({ id: "noExistingLock", ok: false });
    expect(loadAccount).toHaveBeenCalled();
  });

  it("turns a lost race for the same balance into a readable error", async () => {
    const a = await openTrade();
    const b = await openTrade();
    for (const t of [a, b]) await f.as(f.owner).trade.agree({ tradeId: t.id });
    // Both pass the "another trade" pre-check before either commits.
    const results = await Promise.allSettled(
      [a, b].map((t) => f.as(f.owner).trade.recordLock({ tradeId: t.id, txHash: TX.lock })),
    );
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed).toHaveLength(1);
    expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(/another trade/);
  });
});

describe("timing data for the UI (Q-17, Q-4)", () => {
  it("sends the server's clock with the claim window so the countdown can correct a wrong device clock", async () => {
    const t = await lockedTrade();
    vi.spyOn(horizon, "claimableBalances").mockReturnValue({
      claimableBalance: () => ({ call: async () => ({ claimants: [] }) }),
    } as never);
    const before = Date.now();
    const w = await f.as(f.taker).trade.claimWindow({ tradeId: t.id });
    expect(w.serverNow).toBeGreaterThanOrEqual(before);
    expect(w.serverNow).toBeLessThanOrEqual(Date.now());
  });

  it("lists when each trade was locked, by the ledger", async () => {
    const t = await lockedTrade();
    const open = await openTrade();
    const mine = await f.as(f.owner).trade.mine();
    expect(mine.find((x) => x.id === t.id)!.lockedAt).toEqual(LOCKED_AT);
    expect(mine.find((x) => x.id === open.id)!.lockedAt).toBeNull();
  });

  it("falls back to when Pairy recorded the lock for rows from before the ledger time was stored", async () => {
    const t = await lockedTrade();
    await f.db.update(trades).set({ lockedAt: null }).where(eq(trades.id, t.id));
    const [lockEvent] = (await f.db.select().from(tradeEvents).where(eq(tradeEvents.tradeId, t.id))).filter(
      (e) => e.type === "lock",
    );
    const [row] = (await f.as(f.owner).trade.mine()).filter((x) => x.id === t.id);
    expect(row.lockedAt).toEqual(lockEvent.createdAt);
  });
});

describe("protected trades: open and agree (D2 §5.1)", () => {
  /** A sell_crypto USDC listing: owner = seller, taker = buyer and the opener. */
  async function usdc() {
    f = await tradeFixture("sell_crypto", "USDC");
  }
  const openProtected = (amount = "20", acceptanceVersion = ACCEPTANCE_VERSION) =>
    f.as(f.taker).trade.open({ listingId: f.listing.id, amount, mode: "protected", acceptanceVersion });

  beforeEach(() => {
    vi.stubEnv("PROTECTED_MODE", "on");
    vi.mocked(isArbiterSigner).mockReset().mockResolvedValue(false);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("opens a protected trade the opener has accepted, with no claim window", async () => {
    await usdc();
    const before = new Date();
    const t = await openProtected();
    expect(t).toMatchObject({
      mode: "protected",
      state: "listed",
      openedBy: "buyer",
      windowSeconds: 0,
      acceptanceVersion: ACCEPTANCE_VERSION,
      sellerAcceptedAt: null,
    });
    expect(t.buyerAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(isArbiterSigner).toHaveBeenCalledWith(f.taker);
    expect(isArbiterSigner).toHaveBeenCalledWith(f.owner);
    // The amount is reserved like any open trade's.
    expect((await f.db.select().from(listings).where(eq(listings.id, f.listing.id)))[0].remainingAmount).toBe("80.0000000");
  });

  it("opens claimable trades as before, without asking Horizon about the arbiter", async () => {
    await usdc();
    const t = await f.as(f.taker).trade.open({ listingId: f.listing.id, amount: "20" });
    expect(t).toMatchObject({ mode: "claimable", windowSeconds: 259_200, acceptanceVersion: null, buyerAcceptedAt: null });
    vi.stubEnv("PROTECTED_MODE", "off");
    expect((await f.as(f.taker).trade.open({ listingId: f.listing.id, amount: "20", mode: "claimable" })).mode).toBe("claimable");
    expect(isArbiterSigner).not.toHaveBeenCalled();
  });

  it("refuses a new protected trade while PROTECTED_MODE is not on (DECISIONS 6)", async () => {
    await usdc();
    for (const off of ["off", "", "ON"]) {
      vi.stubEnv("PROTECTED_MODE", off);
      await expect(openProtected()).rejects.toThrow("Protected trades are switched off right now.");
    }
    vi.unstubAllEnvs();
    delete process.env.PROTECTED_MODE;
    await expect(openProtected()).rejects.toThrow("Protected trades are switched off right now.");
    expect(await f.db.select().from(trades)).toEqual([]);
  });

  it("refuses a protected trade on an asset the escrow does not hold", async () => {
    f = await tradeFixture("sell_crypto", "XLM");
    await expect(openProtected()).rejects.toThrow("Protected trades work with USDC only for now.");
    f = await tradeFixture("sell_crypto", "EURC");
    await expect(openProtected()).rejects.toThrow("Protected trades work with USDC only for now.");
  });

  it("refuses an open without the current acceptance text", async () => {
    await usdc();
    await expect(f.as(f.taker).trade.open({ listingId: f.listing.id, amount: "20", mode: "protected" })).rejects.toThrow(
      "The protected-trade text changed. Read it again.",
    );
    await expect(openProtected("20", "0".repeat(64))).rejects.toThrow("The protected-trade text changed. Read it again.");
  });

  it("refuses a protected trade when either party is an arbiter signer (I13), and when Horizon can't say", async () => {
    await usdc();
    vi.mocked(isArbiterSigner).mockImplementation(async (k) => k === f.taker);
    await expect(openProtected()).rejects.toThrow("Arbiter signer keys can't trade in protected mode.");
    vi.mocked(isArbiterSigner).mockImplementation(async (k) => k === f.owner);
    await expect(openProtected()).rejects.toThrow("Arbiter signer keys can't trade in protected mode.");
    vi.mocked(isArbiterSigner).mockRejectedValue(new Error("Request failed with status code 503"));
    await expect(openProtected()).rejects.toThrow("Couldn't check the arbiter account; try again.");
    expect(await f.db.select().from(trades)).toEqual([]);
  });

  it("agrees only with the same acceptance text the opener accepted", async () => {
    await usdc();
    const t = await openProtected();
    await expect(f.as(f.owner).trade.agree({ tradeId: t.id })).rejects.toThrow("The protected-trade text changed. Read it again.");
    await expect(f.as(f.owner).trade.agree({ tradeId: t.id, acceptanceVersion: "0".repeat(64) })).rejects.toThrow(
      "The protected-trade text changed. Read it again.",
    );
    // A trade opened on an older text cannot be agreed on the new one.
    await f.db.update(trades).set({ acceptanceVersion: "1".repeat(64) }).where(eq(trades.id, t.id));
    await expect(f.as(f.owner).trade.agree({ tradeId: t.id, acceptanceVersion: ACCEPTANCE_VERSION })).rejects.toThrow(
      "The protected-trade text changed. Read it again.",
    );
    expect((await f.db.select().from(trades).where(eq(trades.id, t.id)))[0].state).toBe("listed");
  });

  it("records the agreeing side's acceptance, even with PROTECTED_MODE off (existing trades go on)", async () => {
    await usdc();
    const t = await openProtected();
    vi.stubEnv("PROTECTED_MODE", "off");
    const before = new Date();
    const agreed = await f.as(f.owner).trade.agree({ tradeId: t.id, acceptanceVersion: ACCEPTANCE_VERSION });
    expect(agreed.state).toBe("agreed");
    expect(agreed.sellerAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(agreed.buyerAcceptedAt).toEqual(t.buyerAcceptedAt);
    expect(isArbiterSigner).toHaveBeenLastCalledWith(f.owner);
  });

  it("refuses an agree by an arbiter signer, and when Horizon can't say", async () => {
    await usdc();
    const t = await openProtected();
    vi.mocked(isArbiterSigner).mockResolvedValue(true);
    await expect(f.as(f.owner).trade.agree({ tradeId: t.id, acceptanceVersion: ACCEPTANCE_VERSION })).rejects.toThrow(
      "Arbiter signer keys can't trade in protected mode.",
    );
    vi.mocked(isArbiterSigner).mockRejectedValue(new Error("socket hang up"));
    await expect(f.as(f.owner).trade.agree({ tradeId: t.id, acceptanceVersion: ACCEPTANCE_VERSION })).rejects.toThrow(
      "Couldn't check the arbiter account; try again.",
    );
  });

  it("keeps a claimable agree as it was: no acceptance asked, none stored", async () => {
    await usdc();
    const t = await f.as(f.taker).trade.open({ listingId: f.listing.id, amount: "20" });
    const agreed = await f.as(f.owner).trade.agree({ tradeId: t.id });
    expect(agreed).toMatchObject({ state: "agreed", sellerAcceptedAt: null, buyerAcceptedAt: null });
    expect(isArbiterSigner).not.toHaveBeenCalled();
  });

  it("counts a protected trade in escrow_created or funded as open toward the five (O-24)", async () => {
    await usdc();
    const opened = [];
    for (let i = 0; i < 5; i++) opened.push(await openProtected("10"));
    // Four still listed; one moves on to an escrow, as the escrow router would record it.
    const id = opened[0].id;
    const escrow = {
      state: "funded" as const,
      sellerAcceptedAt: new Date(),
      escrowAdmin: "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5",
      escrowContractId: "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34",
      createTx: "d".repeat(64),
      fundTx: "e".repeat(64),
      fundedAt: new Date(),
    };
    await f.db.update(trades).set(escrow).where(eq(trades.id, id));
    await expect(openProtected("10")).rejects.toThrow(/You already have 5 open trades/);
    await f.db.update(trades).set({ state: "escrow_created" }).where(eq(trades.id, id));
    await expect(openProtected("10")).rejects.toThrow(/You already have 5 open trades/);
    // Once it is settled it no longer counts.
    await f.db.update(trades).set({ state: "released", releaseTx: "f".repeat(64) }).where(eq(trades.id, id));
    expect((await openProtected("10")).state).toBe("listed");
  });

  it("sends a protected trade's problem flag and lock preflight to the escrow instead", async () => {
    await usdc();
    const t = await openProtected();
    await f.as(f.owner).trade.agree({ tradeId: t.id, acceptanceVersion: ACCEPTANCE_VERSION });
    await expect(f.as(f.taker).trade.flagDispute({ tradeId: t.id })).rejects.toThrow(
      "In a protected trade, Flag a problem opens a dispute on the escrow.",
    );
    await expect(f.as(f.owner).trade.lockPreflight({ tradeId: t.id })).rejects.toThrow(/protected trade/);
    expect((await f.db.select().from(trades).where(eq(trades.id, t.id)))[0].disputed).toBe(false);
  });
});
