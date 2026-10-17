import { NotFoundError } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { chatMessages, tradeEvents, trades } from "@/lib/db/schema";
import { horizon, loadAccount } from "@/lib/stellar/horizon";
import { findClaimTx } from "@/lib/stellar/verify";
import { TX, tradeFixture } from "@/lib/trade/test-helpers";

import { closeResetTrades } from "./testnet-reset";

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

const BALANCE = "00000000" + "f".repeat(64);
let f: Awaited<ReturnType<typeof tradeFixture>>;
let liveBalances: Set<string>;
// A reset time after every trade in these tests.
const later = new Date(Date.now() + 60_000);

beforeEach(async () => {
  f = await tradeFixture();
  liveBalances = new Set();
  vi.mocked(loadAccount).mockReset().mockResolvedValue(null);
  vi.mocked(findClaimTx).mockReset().mockResolvedValue(null);
  vi.spyOn(horizon, "claimableBalances").mockReturnValue({
    claimableBalance: (id: string) => ({
      call: async () => {
        if (!liveBalances.has(id)) throw new NotFoundError("Not Found", {});
        return { id };
      },
    }),
  } as never);
});

const open = () => f.as(f.taker).trade.open({ listingId: f.listing.id, amount: "25.5" });
const row = async (id: string) => (await f.db.select().from(trades).where(eq(trades.id, id)))[0];
async function locked() {
  const t = await open();
  await f.as(f.owner).trade.agree({ tradeId: t.id });
  await f.db.update(trades).set({ state: "locked", balanceId: BALANCE, lockTx: TX.lock }).where(eq(trades.id, t.id));
  await f.as(f.taker).chat.send({ tradeId: t.id, body: "see you" });
  return t;
}

describe("closeResetTrades", () => {
  it("only lists what it would close unless told to apply", async () => {
    const t = await locked();
    expect((await closeResetTrades(f.db, { apply: false, before: later })).map((c) => c.id)).toEqual([t.id]);
    expect((await row(t.id)).state).toBe("locked");
  });

  it("closes a locked trade whose balance is gone from the ledger, keeping the lock record and purging the chat", async () => {
    const t = await locked();
    expect(await closeResetTrades(f.db, { apply: true, before: later })).toHaveLength(1);
    expect(await row(t.id)).toMatchObject({ state: "cancelled", lockTx: TX.lock });
    expect(await f.db.select().from(chatMessages).where(eq(chatMessages.tradeId, t.id))).toEqual([]);
    const events = await f.db.select().from(tradeEvents).where(eq(tradeEvents.tradeId, t.id));
    expect(events.at(-1)).toMatchObject({ type: "reset", by: "system" });
  });

  it("leaves a locked trade whose balance is still on the ledger", async () => {
    const t = await locked();
    liveBalances.add(BALANCE);
    expect(await closeResetTrades(f.db, { apply: true, before: later })).toEqual([]);
    expect((await row(t.id)).state).toBe("locked");
  });

  it("closes an unlocked trade only when both accounts are gone, not just an unfunded seller", async () => {
    const t = await open();
    vi.mocked(loadAccount).mockImplementation(async (pk) => (pk === f.taker ? ({ id: pk } as never) : null));
    expect(await closeResetTrades(f.db, { apply: true, before: later })).toEqual([]);
    expect((await row(t.id)).state).toBe("listed");

    vi.mocked(loadAccount).mockResolvedValue(null);
    expect(await closeResetTrades(f.db, { apply: true, before: later })).toHaveLength(1);
    expect((await row(t.id)).state).toBe("cancelled");
  });

  it("never touches a settled trade", async () => {
    const t = await locked();
    await f.db.update(trades).set({ state: "claimed", claimTx: TX.claim }).where(eq(trades.id, t.id));
    expect(await closeResetTrades(f.db, { apply: true, before: later })).toEqual([]);
  });

  it("leaves a locked trade whose balance was claimed but not yet reported: sync records that", async () => {
    const t = await locked();
    vi.mocked(findClaimTx).mockResolvedValue(TX.claim);
    expect(await closeResetTrades(f.db, { apply: true, before: later })).toEqual([]);
    expect((await row(t.id)).state).toBe("locked");
  });

  it("only closes trades opened before the reset, so new users with unfunded keys are safe", async () => {
    const t = await open();
    const reset = new Date(t.createdAt.getTime() - 1000);
    expect(await closeResetTrades(f.db, { apply: true, before: reset })).toEqual([]);
    expect((await row(t.id)).state).toBe("listed");
  });
});
