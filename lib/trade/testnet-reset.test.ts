import { NotFoundError } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { chatMessages, listings, tradeEvents, trades } from "@/lib/db/schema";
import { EscrowNotFoundError, readWasmHash } from "@/lib/escrow/read";
import { horizon, loadAccount } from "@/lib/stellar/horizon";
import { findClaimTx } from "@/lib/stellar/verify";
import { TX, openProtectedTrade, tradeFixture } from "@/lib/trade/test-helpers";

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
vi.mock("@/lib/escrow/read", async (orig) => ({ ...(await orig<typeof import("@/lib/escrow/read")>()), readEscrow: vi.fn(), readWasmHash: vi.fn() }));

const BALANCE = "00000000" + "f".repeat(64);
let f: Awaited<ReturnType<typeof tradeFixture>>;
let liveBalances: Set<string>;
// A reset time after every trade in these tests.
let later: Date;

beforeEach(async () => {
  f = await tradeFixture();
  later = new Date(Date.now() + 60_000);
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

describe("closeResetTrades: protected trades (FIXES F-13)", () => {
  const ESCROW = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
  const CREATE_TX = "1".repeat(64);
  let createOnHorizon: boolean;
  let contractOnLedger: "live" | "archived" | "gone";

  beforeEach(() => {
    createOnHorizon = false;
    contractOnLedger = "gone";
    vi.spyOn(horizon, "transactions").mockReturnValue({
      transaction: (hash: string) => ({
        call: async () => {
          if (hash !== CREATE_TX || !createOnHorizon) throw new NotFoundError("Not Found", {});
          return { hash, successful: true };
        },
      }),
    } as never);
    // An archived instance is still returned by Soroban RPC (C-3); only a missing one is gone.
    vi.mocked(readWasmHash).mockImplementation(async (id) => {
      if (contractOnLedger === "gone") throw new EscrowNotFoundError(id);
      return "1231807d01111bee78a846ddacdd0a6cf88b762115e70f5bce16ffabd660e47f";
    });
  });

  async function escrowTrade(state: "escrow_created" | "funded") {
    const [usdc] = await f.db.insert(listings).values({ ...f.listing, id: undefined, asset: "USDC" }).returning();
    const t = await openProtectedTrade({ ...f, listing: usdc }, "20");
    await f.db
      .update(trades)
      .set({
        state,
        sellerAcceptedAt: new Date(),
        escrowAdmin: f.stranger,
        escrowContractId: ESCROW,
        createTx: CREATE_TX,
        ...(state === "funded" ? { fundTx: "2".repeat(64), fundedAt: new Date() } : {}),
      })
      .where(eq(trades.id, t.id));
    await f.as(f.taker).chat.send({ tradeId: t.id, body: "see you" });
    return { ...t, listingId: usdc.id };
  }
  const left = async (listingId: string) => (await f.db.select().from(listings).where(eq(listings.id, listingId)))[0].remainingAmount;

  it.each(["escrow_created", "funded"] as const)("closes a %s trade whose creation is gone from Horizon and whose contract is gone from the ledger", async (state) => {
    const t = await escrowTrade(state);
    expect(await left(t.listingId)).toBe("80.0000000");
    expect((await closeResetTrades(f.db, { apply: true, before: later })).map((c) => [c.id, c.state])).toEqual([[t.id, state]]);
    expect(await row(t.id)).toMatchObject({ state: "cancelled", createTx: CREATE_TX, escrowContractId: ESCROW });
    expect(await f.db.select().from(chatMessages).where(eq(chatMessages.tradeId, t.id))).toEqual([]);
    // The listing gets its reservation back.
    expect(await left(t.listingId)).toBe("100.0000000");
  });

  it("keeps it while Horizon still has the creation: a missing contract alone is not a reset", async () => {
    const t = await escrowTrade("funded");
    createOnHorizon = true;
    expect(await closeResetTrades(f.db, { apply: true, before: later })).toEqual([]);
    expect((await row(t.id)).state).toBe("funded");
  });

  it.each(["live", "archived"] as const)("keeps it while the contract is on the ledger (%s), whatever Horizon says", async (onLedger) => {
    const t = await escrowTrade("escrow_created");
    contractOnLedger = onLedger;
    expect(await closeResetTrades(f.db, { apply: true, before: later })).toEqual([]);
    expect((await row(t.id)).state).toBe("escrow_created");
  });

  it("stops on a Soroban RPC failure rather than guessing", async () => {
    await escrowTrade("funded");
    vi.mocked(readWasmHash).mockRejectedValue(new Error("fetch failed"));
    await expect(closeResetTrades(f.db, { apply: true, before: later })).rejects.toThrow("fetch failed");
  });
});
