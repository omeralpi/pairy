import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { tradeEvents } from "@/lib/db/schema";
import { verifyClaimTx, verifyLockTx } from "@/lib/stellar/verify";
import { TX, tradeFixture } from "@/lib/trade/test-helpers";

vi.mock("@/lib/stellar/verify", () => ({ verifyLockTx: vi.fn(), verifyClaimTx: vi.fn() }));

const BALANCE = "00000000" + "d".repeat(64);

let f: Awaited<ReturnType<typeof tradeFixture>>;

beforeEach(async () => {
  vi.mocked(verifyLockTx).mockReset().mockResolvedValue({ balanceId: BALANCE });
  vi.mocked(verifyClaimTx).mockReset();
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
    expect((await openTrade("10")).state).toBe("listed");
    expect((await openTrade("100")).state).toBe("listed");
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
    });

    vi.mocked(verifyClaimTx).mockResolvedValue({ claimant: f.taker });
    const claimed = await f.as(f.taker).trade.recordClaim({ tradeId: t.id, txHash: TX.claim });
    expect(claimed).toMatchObject({ state: "claimed", claimTx: TX.claim });
    expect(verifyClaimTx).toHaveBeenCalledWith(TX.claim, BALANCE);

    const room = await f.as(f.taker).trade.byId({ id: t.id });
    expect(room.role).toBe("buyer");
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
    vi.mocked(verifyLockTx).mockRejectedValue(new Error("The lock in x is not in XLM."));
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
