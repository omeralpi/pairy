// trade.sync against the real findLockTx/verifyLockTx, with only Horizon
// mocked, so the search itself is under test (the router tests mock it away).

import { Account, Asset, NotFoundError, type Transaction } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { trades } from "@/lib/db/schema";
import { horizon } from "@/lib/stellar/horizon";
import { buildLockTransaction } from "@/lib/stellar/settlement";
import { lockBalanceId } from "@/lib/stellar/verify";
import { tradeFixture } from "@/lib/trade/test-helpers";

vi.mock("@/lib/stellar/horizon", async (orig) => ({
  ...(await orig<typeof import("@/lib/stellar/horizon")>()),
  loadAccount: vi.fn(async () => null),
}));

type OpRecord = Record<string, unknown> & { created_at: string };
let ledger: Record<string, { successful: boolean; envelope_xdr: string; created_at: string }>;
let opsByAccount: Record<string, OpRecord[]>;
// Live claimable balances, as GET /claimable_balances lists them.
let liveBalances: (Record<string, unknown> & { id: string })[];
let opsByBalance: Record<string, OpRecord[]>;
let opPages: number;
// When set, every transaction lookup fails like an unavailable Horizon.
let txError: (() => Error) | null;
let f: Awaited<ReturnType<typeof tradeFixture>>;

function pageOf(records: OpRecord[], from = 0): unknown {
  opPages++;
  return { records: records.slice(from, from + 200), next: async () => pageOf(records, from + 200) };
}

beforeEach(async () => {
  ledger = {};
  opsByAccount = {};
  liveBalances = [];
  opsByBalance = {};
  opPages = 0;
  txError = null;
  vi.spyOn(horizon, "transactions").mockReturnValue({
    transaction: (hash: string) => ({
      call: async () => {
        if (txError) throw txError();
        if (!ledger[hash]) throw new NotFoundError("Not Found", {});
        return ledger[hash];
      },
    }),
  } as never);
  vi.spyOn(horizon, "claimableBalances").mockImplementation(() => {
    const list = {
      claimableBalance: (id: string) => ({ call: async () => ({ id }) }),
      sponsor: () => list,
      claimant: () => list,
      limit: () => list,
      call: async () => ({ records: liveBalances }),
    };
    return list as never;
  });
  vi.spyOn(horizon, "operations").mockImplementation(() => {
    let records: OpRecord[] = [];
    const b = {
      forAccount: (id: string) => ((records = opsByAccount[id] ?? []), b),
      forClaimableBalance: (id: string) => ((records = opsByBalance[id] ?? []), b),
      order: () => b,
      limit: () => b,
      call: async () => pageOf(records),
    };
    return b as never;
  });
  f = await tradeFixture();
});

afterEach(() => vi.restoreAllMocks());

/** The seller's 25.5 XLM lock to the buyer, landed `minutesFromNow` from now. */
function landLock(sequence: string, minutesFromNow = 0): { hash: string; tx: Transaction } {
  const tx = buildLockTransaction(new Account(f.owner, sequence), {
    asset: Asset.native(),
    amount: "25.5",
    buyer: f.taker,
  });
  const hash = Buffer.from(tx.hash()).toString("hex");
  const created_at = new Date(Date.now() + minutesFromNow * 60_000).toISOString();
  ledger[hash] = { successful: true, envelope_xdr: tx.toEnvelope().toXDR("base64"), created_at };
  (opsByAccount[f.owner] ??= []).unshift({
    type: "create_claimable_balance",
    transaction_successful: true,
    transaction_hash: hash,
    created_at,
    source_account: f.owner,
    asset: "native",
    amount: "25.5000000",
    claimants: [{ destination: f.taker }, { destination: f.owner }],
  });
  const id = lockBalanceId(tx);
  liveBalances.push({
    id,
    asset: "native",
    amount: "25.5000000",
    sponsor: f.owner,
    claimants: [{ destination: f.taker }, { destination: f.owner }],
  });
  opsByBalance[id] = [{ type: "create_claimable_balance", transaction_successful: true, transaction_hash: hash, created_at }];
  return { hash, tx };
}

const open = () => f.as(f.taker).trade.open({ listingId: f.listing.id, amount: "25.5" });

describe("trade.sync never gives a lock to the wrong trade (review finding 1)", () => {
  it("leaves a trade cancelled before any agreement alone", async () => {
    const a = await open();
    await f.as(f.taker).trade.cancel({ tradeId: a.id });
    const b = await open();
    await f.as(f.owner).trade.agree({ tradeId: b.id });
    const { hash, tx } = landLock("9");

    expect((await f.as(f.taker).trade.sync({ tradeId: a.id })).state).toBe("cancelled");
    expect(await f.as(f.owner).trade.recordLock({ tradeId: b.id, txHash: hash })).toMatchObject({
      state: "locked",
      balanceId: lockBalanceId(tx),
    });
  });

  it("gives the lock to the live trade, not to a cancelled one with the same terms", async () => {
    const a = await open();
    await f.as(f.owner).trade.agree({ tradeId: a.id });
    await f.as(f.taker).trade.cancel({ tradeId: a.id });
    const b = await open();
    await f.as(f.owner).trade.agree({ tradeId: b.id });
    landLock("9", 1);

    expect((await f.as(f.taker).trade.sync({ tradeId: a.id })).state).toBe("cancelled");
    expect((await f.as(f.taker).trade.sync({ tradeId: b.id })).state).toBe("locked");
  });

  it("leaves placing a lock to the seller when two agreed trades have the same terms (RF-8)", async () => {
    const a = await open();
    const b = await open();
    for (const t of [a, b]) await f.as(f.owner).trade.agree({ tradeId: t.id });
    const { hash } = landLock("9", 1);
    expect((await f.as(f.taker).trade.sync({ tradeId: b.id })).state).toBe("agreed");
    expect((await f.as(f.taker).trade.sync({ tradeId: a.id })).state).toBe("agreed");
    // The seller's own report still places it on the trade it was signed for.
    expect((await f.as(f.owner).trade.recordLock({ tradeId: a.id, txHash: hash })).state).toBe("locked");
  });

  it("records a lock that landed just after an agreed trade was cancelled", async () => {
    const a = await open();
    await f.as(f.owner).trade.agree({ tradeId: a.id });
    await f.as(f.taker).trade.cancel({ tradeId: a.id });
    landLock("9", 2);
    expect((await f.as(f.taker).trade.sync({ tradeId: a.id })).state).toBe("locked");
  });

  it("stops a cancelled trade's search where the next trade with the same terms opened (RB2-4)", async () => {
    const a = await open();
    await f.as(f.owner).trade.agree({ tradeId: a.id });
    await f.as(f.taker).trade.cancel({ tradeId: a.id });
    const b = await open();
    await f.as(f.owner).trade.agree({ tradeId: b.id });
    await f.as(f.taker).trade.cancel({ tradeId: b.id });
    landLock("9", 1);

    expect((await f.as(f.taker).trade.sync({ tradeId: a.id })).state).toBe("cancelled");
    expect((await f.as(f.taker).trade.sync({ tradeId: b.id })).state).toBe("locked");
  });

  it("does not record a lock made long after the cancel", async () => {
    const a = await open();
    await f.as(f.owner).trade.agree({ tradeId: a.id });
    await f.as(f.taker).trade.cancel({ tradeId: a.id });
    landLock("9", 60);
    expect((await f.as(f.taker).trade.sync({ tradeId: a.id })).state).toBe("cancelled");
  });
});

describe("trade.sync cost and errors (review findings 3 and 4)", () => {
  it("does not search Horizon again within a few seconds", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await f.as(f.taker).trade.sync({ tradeId: t.id });
    const after = opPages;
    await f.as(f.taker).trade.sync({ tradeId: t.id });
    await f.as(f.owner).trade.sync({ tradeId: t.id });
    expect(opPages).toBe(after);
  });

  it("searches again right away after a sync that failed (RB2-2)", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    landLock("9");
    txError = () => new Error("Request failed with status code 503");
    await expect(f.as(f.taker).trade.sync({ tradeId: t.id })).rejects.toThrow();
    txError = null;
    expect((await f.as(f.taker).trade.sync({ tradeId: t.id })).state).toBe("locked");
  });

  it("shares the sync throttle with the lock preflight (RB2-6)", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    await f.as(f.owner).trade.lockPreflight({ tradeId: t.id });
    const after = opPages;
    await f.as(f.owner).trade.lockPreflight({ tradeId: t.id });
    await f.as(f.taker).trade.sync({ tradeId: t.id });
    expect(opPages).toBe(after);
  });

  it("sees a lock that landed since the last search even while throttled (RR2-1)", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    expect((await f.as(f.owner).trade.lockPreflight({ tradeId: t.id })).checks[0].id).not.toBe("noExistingLock");
    landLock("9");
    const pre = await f.as(f.owner).trade.lockPreflight({ tradeId: t.id });
    expect(pre.checks[0]).toMatchObject({ id: "noExistingLock", ok: false });
  });

  it("still reports a lock it found earlier while the preflight is throttled", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    landLock("9");
    const first = await f.as(f.owner).trade.lockPreflight({ tradeId: t.id });
    expect(first.checks[0]).toMatchObject({ id: "noExistingLock", ok: false });
    const second = await f.as(f.owner).trade.lockPreflight({ tradeId: t.id });
    expect(second.checks[0]).toMatchObject({ id: "noExistingLock", ok: false });
  });

  it("shows a generic message, not the raw network error, when Horizon cannot be reached (RB2-5)", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    landLock("9");
    txError = () => new Error("getaddrinfo ENOTFOUND horizon-testnet.stellar.org");
    const err = await f.as(f.taker).trade.sync({ tradeId: t.id }).catch((e: Error) => e);
    expect(String(err)).not.toMatch(/ENOTFOUND|getaddrinfo/);
    expect(String(err)).toMatch(/Stellar testnet/);
  });

  it("dates the lock by the ledger, not by when Pairy recorded it (RB2-3)", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    const { hash } = landLock("9", 3);
    await f.as(f.taker).trade.sync({ tradeId: t.id });
    const [row] = (await f.as(f.taker).trade.mine()).filter((x) => x.id === t.id);
    expect(row.lockedAt).toEqual(new Date(ledger[hash].created_at));
  });

  it("reports a database failure as an internal error, not as a readable message", async () => {
    const t = await open();
    await f.as(f.owner).trade.agree({ tradeId: t.id });
    const select = f.db.select.bind(f.db);
    // The first select is tradeForParticipant; fail the next one, inside the sync.
    vi.spyOn(f.db, "select")
      .mockImplementationOnce(select)
      .mockImplementationOnce(() => {
        throw new Error('Failed query: select "balance_id" from "trades"');
      });
    await expect(f.as(f.taker).trade.sync({ tradeId: t.id })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});
