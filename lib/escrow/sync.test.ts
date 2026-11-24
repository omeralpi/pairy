// syncProtectedTrade (D2 §4.1, "chain wins") on pglite, against the chain as
// it was recorded: Gate D2's escrow (created, funded and released) and the
// day-12 gate's two real-arbiter exits (disputed, then resolved to the buyer
// and to the seller). Horizon is faked from tests/fixtures/horizon/*.json and
// Soroban RPC is replayed from tests/fixtures/soroban-rpc/*.json, so the real
// findEscrowTx, verifyEscrowTx and readEscrow run; nothing reaches the network.
// The few states nobody recorded (an escrow funded and still open) are stubbed
// as readEscrow's answer.

import { readFileSync } from "node:fs";
import path from "node:path";

import { NotFoundError } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatMessages, disputeAnswers, listings, tradeEvents, trades, users } from "@/lib/db/schema";
import { createTestDb } from "@/lib/db/test-setup";
import { ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { horizon } from "@/lib/stellar/horizon";
import { callerFor } from "@/lib/trade/test-helpers";

import { EscrowNotFoundError, readEscrow, readWasmHash } from "./read";
import { syncProtectedTrade } from "./sync";
import { expectedTerms } from "./terms";

vi.mock("./read", async (orig) => ({ ...(await orig<typeof import("./read")>()), readEscrow: vi.fn(), readWasmHash: vi.fn() }));
const actual = await vi.importActual<typeof import("./read")>("./read");

type Recorded = { hash: string; transaction: Record<string, any>; operations: Record<string, any>[] };
const fixture = (dir: string, name: string) => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures", dir, `${name}.json`), "utf8"));
const GATE: { steps: Record<"deploy" | "fund" | "release", Recorded>; accounts: Record<string, { account: string; operations: Record<string, any>[] }> } =
  fixture("horizon", "gate-d2");
type Exit = { contractId: string; accounts: { creation: string; seller: string; buyer: string }; steps: Record<"deploy" | "fund" | "dispute" | "resolve", Recorded> };
const WP15: { exits: Record<"buyer" | "seller", Exit>; accounts: Record<string, Record<string, any>[]> } = fixture("horizon", "wp15-disputes");

// Gate D2's trade (scripts/evidence/out/escrow-release-real.json).
const GATE_TRADE = {
  seller: "GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y",
  buyer: "GB2HNRJNZDLD2FRPS4SKS5Y4HB65IUDI6QSVPID7ZADMLBBQ255TZOYQ",
  admin: "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5",
  contractId: "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34",
};
const exitTrade = (e: Exit) => ({ seller: e.accounts.seller, buyer: e.accounts.buyer, admin: e.accounts.creation, contractId: e.contractId });
const { buyer: BUYER_EXIT, seller: SELLER_EXIT } = WP15.exits;

// ---- Horizon, faked from the recorded records ----
let txs: Record<string, Record<string, any>>;
let opsByTx: Record<string, Record<string, any>[]>;
let opsByAccount: Record<string, Record<string, any>[]>;

beforeEach(() => {
  const steps = [...Object.values(GATE.steps), ...Object.values(WP15.exits).flatMap((e) => Object.values(e.steps))];
  txs = Object.fromEntries(steps.map((s) => [s.hash, structuredClone(s.transaction)]));
  opsByTx = Object.fromEntries(steps.map((s) => [s.hash, structuredClone(s.operations)]));
  opsByAccount = {
    ...Object.fromEntries(Object.values(GATE.accounts).map((a) => [a.account, structuredClone(a.operations)])),
    ...structuredClone(WP15.accounts),
  };
  vi.spyOn(horizon, "transactions").mockReturnValue({
    transaction: (hash: string) => ({
      call: async () => {
        if (!txs[hash]) throw new NotFoundError("Not Found", {});
        return txs[hash];
      },
    }),
  } as never);
  vi.spyOn(horizon, "operations").mockImplementation(() => {
    let records: Record<string, any>[] | null = null;
    let size = 10;
    const pageOf = (from: number): unknown => ({ records: records!.slice(from, from + size), next: async () => pageOf(from + size) });
    const builder = {
      forTransaction: (hash: string) => ((records = opsByTx[hash] ?? []), builder),
      forAccount: (id: string) => ((records = opsByAccount[id] ?? null), builder),
      order: () => builder,
      limit: (n: number) => ((size = n), builder),
      call: async () => {
        if (records === null) throw new NotFoundError("Not Found", {});
        return pageOf(0);
      },
    };
    return builder as never;
  });
});

// ---- Soroban RPC ----
type Call = { request: { method: string; params: unknown }; response: any };

/** The real readEscrow and readWasmHash, answered only with these recorded Soroban RPC calls. */
function chainRecorded(...calls: Call[]) {
  vi.mocked(readEscrow).mockImplementation(actual.readEscrow);
  vi.mocked(readWasmHash).mockImplementation(actual.readWasmHash);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const hit = calls.find((c) => c.request.method === body.method && JSON.stringify(c.request.params) === JSON.stringify(body.params));
      if (!hit) throw new Error(`unrecorded Soroban RPC request: ${body.method}`);
      return new Response(JSON.stringify(hit.response), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

/** An exit's escrow mid-dispute (as WP-15 read it right after the dispute), or as it is now: resolved. */
function exitChain(exit: "buyer" | "seller", at: "dispute" | "resolved") {
  const rec = fixture("soroban-rpc", `wp15-dispute-${exit}-real`);
  const call: Call = structuredClone(rec.calls[0]);
  if (at === "resolved") {
    // The ["Escrow"] entry (the second key) as Soroban RPC returned it when the fixture was recorded.
    const escrowKey = (call.request.params as { keys: string[] }).keys[1];
    Object.assign(call.response.result.entries.find((e: { key: string }) => e.key === escrowKey), rec.replacedFromToday.escrowEntry);
  }
  chainRecorded(call);
}

const LIVE = { latestLedger: 5_900_000, instanceLiveUntil: 6_018_006, escrowLiveUntil: 6_018_006 };

/** What readEscrow answers for a state nobody recorded (Gate D2's terms). */
function chainSays(status: { disputed?: boolean; released?: boolean; resolved?: boolean; balanceStroops?: bigint }, ttl = LIVE) {
  vi.mocked(readEscrow).mockResolvedValue({
    terms: expectedTerms({ buyer: GATE_TRADE.buyer, seller: GATE_TRADE.seller, amount: "5", escrowAdmin: GATE_TRADE.admin }),
    status: { disputed: false, released: false, resolved: false, balanceStroops: 0n, ...status },
    ttl,
  });
}

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T14:00:00Z"));
  vi.mocked(readEscrow).mockReset().mockRejectedValue(new Error("readEscrow not set up for this test"));
  vi.mocked(readWasmHash).mockReset().mockRejectedValue(new Error("readWasmHash not set up for this test"));
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- the database ----
async function db() {
  const { db } = await createTestDb();
  const parties = [GATE_TRADE, exitTrade(BUYER_EXIT), exitTrade(SELLER_EXIT)].flatMap((t) => [t.seller, t.buyer]);
  await db.insert(users).values(parties.map((publicKey) => ({ publicKey })));
  return db;
}
let d: Awaited<ReturnType<typeof db>>;
beforeEach(async () => {
  d = await db();
});

/** A protected 5 USDC trade on the seller's own listing, written straight into the state given. */
async function protectedTrade(t: typeof GATE_TRADE, values: Partial<typeof trades.$inferInsert>) {
  const [listing] = await d
    .insert(listings)
    .values({
      owner: t.seller,
      side: "sell_crypto",
      asset: "USDC",
      minAmount: "1",
      maxAmount: "100",
      remainingAmount: "95",
      fiatCode: "TRY",
      rate: "41.0000",
      cityId: "745044",
      cityName: "Istanbul",
      countryCode: "TR",
      latitude: "41.01384",
      longitude: "28.94966",
    })
    .returning();
  const [trade] = await d
    .insert(trades)
    .values({
      listingId: listing.id,
      seller: t.seller,
      buyer: t.buyer,
      openedBy: "buyer",
      mode: "protected",
      asset: "USDC",
      amount: "5",
      fiatCode: "TRY",
      fiatAmount: "205.00",
      windowSeconds: 0,
      acceptanceVersion: ACCEPTANCE_VERSION,
      sellerAcceptedAt: new Date("2026-11-24T07:59:00Z"),
      buyerAcceptedAt: new Date("2026-11-24T07:58:00Z"),
      escrowAdmin: t.admin,
      escrowContractId: t.contractId,
      escrowPreparedAt: new Date("2026-11-24T08:00:00Z"),
      // Before any of the recorded transactions: the searches stop at the trade's creation.
      createdAt: new Date("2026-11-24T07:58:00Z"),
      state: "agreed",
      ...values,
    })
    .returning();
  return trade;
}
const row = async (id: string) => (await d.select().from(trades).where(eq(trades.id, id)))[0];
const remaining = async (id: string) => (await d.select().from(listings).where(eq(listings.id, (await row(id)).listingId)))[0].remainingAmount;
const events = async (id: string) =>
  (await d.select().from(tradeEvents).where(eq(tradeEvents.tradeId, id))).map((e) => [e.type, e.by, e.txHash]);

const created = (s: Exit["steps"] | typeof GATE.steps) => ({ state: "escrow_created" as const, createTx: s.deploy.hash });
const funded = (s: Exit["steps"] | typeof GATE.steps) => ({
  ...created(s),
  state: "funded" as const,
  fundTx: s.fund.hash,
  fundedAt: new Date(txsAt(s.fund)),
});
const txsAt = (r: Recorded) => r.transaction.created_at as string;

describe("syncProtectedTrade: a step that landed but was never reported is recorded from the chain", () => {
  it("finds a creation nobody reported and follows Gate D2's escrow through its fund to its release", async () => {
    const t = await protectedTrade(GATE_TRADE, {});
    chainRecorded(...fixture("soroban-rpc", "gate-d2").calls);
    const after = await syncProtectedTrade(d, t);
    expect(after).toMatchObject({
      state: "released",
      createTx: GATE.steps.deploy.hash,
      fundTx: GATE.steps.fund.hash,
      fundedAt: new Date("2026-11-24T08:28:02Z"),
      releaseTx: GATE.steps.release.hash,
    });
    expect(await events(t.id)).toEqual([
      ["escrowCreate", "seller", GATE.steps.deploy.hash],
      ["fund", "seller", GATE.steps.fund.hash],
      ["release", "seller", GATE.steps.release.hash],
    ]);
    expect(await remaining(t.id)).toBe("95.0000000");
  });

  it("records a creation whose escrow Soroban RPC still shows but has archived (C-3: archived is not gone)", async () => {
    const t = await protectedTrade(GATE_TRADE, {});
    // Soroban RPC sends liveUntilLedgerSeq 0 for an archived entry, and still returns it.
    chainSays({}, { latestLedger: 6_100_000, instanceLiveUntil: 0, escrowLiveUntil: 0 });
    vi.mocked(readWasmHash).mockResolvedValue("1231807d01111bee78a846ddacdd0a6cf88b762115e70f5bce16ffabd660e47f");
    expect(await syncProtectedTrade(d, t)).toMatchObject({ state: "escrow_created", createTx: GATE.steps.deploy.hash });
  });

  it("records a fund that landed after the trade was cancelled (chain wins), reserving the amount on the listing again", async () => {
    const t = await protectedTrade(GATE_TRADE, { ...created(GATE.steps), state: "cancelled" });
    await d.update(listings).set({ remainingAmount: "100" }).where(eq(listings.id, t.listingId));
    chainSays({ balanceStroops: 50_000_000n });
    const after = await syncProtectedTrade(d, t);
    expect(after).toMatchObject({ state: "funded", fundTx: GATE.steps.fund.hash, fundedAt: new Date("2026-11-24T08:28:02Z") });
    expect(await remaining(t.id)).toBe("95.0000000");
    expect((await events(t.id)).at(-1)).toEqual(["fund", "seller", GATE.steps.fund.hash]);
  });

  it("counts a fund by the escrow's USDC balance, not a stray amount below it (X-07)", async () => {
    const t = await protectedTrade(GATE_TRADE, created(GATE.steps));
    chainSays({ balanceStroops: 49_999_999n });
    expect(await syncProtectedTrade(d, t)).toMatchObject({ state: "escrow_created", fundTx: null });
  });

  it("records a dispute opened outside Pairy's app, starting the 24 hours when Pairy records it (DECISIONS 1)", async () => {
    const t = await protectedTrade(exitTrade(BUYER_EXIT), funded(BUYER_EXIT.steps));
    exitChain("buyer", "dispute");
    const after = await syncProtectedTrade(d, t);
    expect(after).toMatchObject({
      state: "funded",
      disputed: true,
      disputeTx: BUYER_EXIT.steps.dispute.hash,
      // The ledger time of the dispute, and the moment Pairy found it.
      disputedAt: new Date("2026-11-24T09:56:07Z"),
      disputeRecordedAt: new Date("2026-11-24T14:00:00Z"),
      disputeOpenedBy: "buyer",
    });
    expect((await events(t.id)).at(-1)).toEqual(["escrowDispute", "buyer", BUYER_EXIT.steps.dispute.hash]);
  });

  it("reads who opened the dispute from the transaction: in the seller exit, the seller", async () => {
    const t = await protectedTrade(exitTrade(SELLER_EXIT), funded(SELLER_EXIT.steps));
    exitChain("seller", "dispute");
    expect(await syncProtectedTrade(d, t)).toMatchObject({ disputed: true, disputeOpenedBy: "seller", disputeTx: SELLER_EXIT.steps.dispute.hash });
  });

  it.each([
    ["buyer", "resolved_buyer", "95.0000000"],
    ["seller", "resolved_seller", "100.0000000"],
  ] as const)("records the arbiter's resolution in the %s exit as %s, the dispute first, and ends the trade", async (exit, state, left) => {
    const e = WP15.exits[exit];
    const t = await protectedTrade(exitTrade(e), funded(e.steps));
    await d.insert(chatMessages).values({ tradeId: t.id, author: e.accounts.buyer, body: "At the cafe." });
    exitChain(exit, "resolved");
    const after = await syncProtectedTrade(d, t);
    expect(after).toMatchObject({ state, disputed: true, disputeTx: e.steps.dispute.hash, resolveTx: e.steps.resolve.hash, resolvedAt: new Date(txsAt(e.steps.resolve)) });
    expect((await events(t.id)).slice(-2)).toEqual([
      ["escrowDispute", exit, e.steps.dispute.hash],
      ["resolve", "arbiter", e.steps.resolve.hash],
    ]);
    // Terminal: the chat goes; the seller outcome gives the listing its 5 back (D3).
    expect(await d.select().from(chatMessages).where(eq(chatMessages.tradeId, t.id))).toEqual([]);
    expect(await remaining(t.id)).toBe(left);
  });

  it("records the resolution of a dispute Pairy already has, keeping the answers and dropping the notes", async () => {
    const e = BUYER_EXIT;
    const t = await protectedTrade(exitTrade(e), {
      ...funded(e.steps),
      disputed: true,
      disputeTx: e.steps.dispute.hash,
      disputedAt: new Date("2026-11-24T09:56:07Z"),
      disputeRecordedAt: new Date("2026-11-24T09:56:30Z"),
      disputeOpenedBy: "buyer",
    });
    await d.insert(disputeAnswers).values([
      { tradeId: t.id, role: "seller", cashHandedOver: true, note: "Paid in full." },
      { tradeId: t.id, role: "buyer", cashHandedOver: true, note: null },
    ]);
    exitChain("buyer", "resolved");
    expect(await syncProtectedTrade(d, t)).toMatchObject({ state: "resolved_buyer", resolveTx: e.steps.resolve.hash });
    expect(await events(t.id)).toEqual([["resolve", "arbiter", e.steps.resolve.hash]]);
    const answers = await d.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, t.id));
    expect(answers.map((a) => [a.role, a.cashHandedOver, a.note]).sort()).toEqual([
      ["buyer", true, null],
      ["seller", true, null],
    ]);
  });
});

describe("syncProtectedTrade: what it leaves alone", () => {
  it("does nothing while the prepared creation has not landed, and asks Horizon nothing", async () => {
    const t = await protectedTrade(GATE_TRADE, {});
    vi.mocked(readEscrow).mockRejectedValue(new EscrowNotFoundError(GATE_TRADE.contractId));
    expect(await syncProtectedTrade(d, t)).toMatchObject({ state: "agreed", createTx: null });
    expect(horizon.operations).not.toHaveBeenCalled();
  });

  it("lets a Soroban RPC or Horizon outage through, so the caller retries; it never reads one as 'nothing there'", async () => {
    const t = await protectedTrade(GATE_TRADE, funded(GATE.steps));
    vi.mocked(readEscrow).mockRejectedValue(new Error("fetch failed"));
    await expect(syncProtectedTrade(d, t)).rejects.toThrow("fetch failed");
    chainSays({ disputed: true, balanceStroops: 50_000_000n });
    vi.spyOn(horizon, "operations").mockImplementation(() => {
      throw new Error("Request failed with status code 503");
    });
    await expect(syncProtectedTrade(d, t)).rejects.toThrow(/503/);
    expect(await row(t.id)).toMatchObject({ state: "funded", disputed: false });
  });

  it("leaves the row and logs sync.unplaced when the chain shows a step no transaction explains", async () => {
    const t = await protectedTrade(exitTrade(BUYER_EXIT), funded(BUYER_EXIT.steps));
    exitChain("buyer", "dispute");
    opsByAccount[BUYER_EXIT.accounts.buyer] = [];
    expect(await syncProtectedTrade(d, t)).toMatchObject({ state: "funded", disputed: false });
    expect(log.mock.calls.flat().join()).toMatch(/"evt":"sync.unplaced"/);
  });

  it("leaves a creation whose escrow on chain is not this trade's, and logs it", async () => {
    const t = await protectedTrade(GATE_TRADE, { amount: "6" });
    chainRecorded(...fixture("soroban-rpc", "gate-d2").calls);
    expect(await syncProtectedTrade(d, t)).toMatchObject({ state: "agreed", createTx: null });
    expect(log.mock.calls.flat().join()).toMatch(/"evt":"sync.unplaced"/);
  });

  it("changes nothing on a funded escrow the chain shows untouched, but marks the trade synced (F-12)", async () => {
    const t = await protectedTrade(GATE_TRADE, { ...funded(GATE.steps), lastSyncedAt: null });
    chainSays({ balanceStroops: 50_000_000n });
    const after = await syncProtectedTrade(d, t);
    expect(after).toMatchObject({ state: "funded", disputed: false });
    expect((await row(t.id)).lastSyncedAt).toEqual(new Date("2026-11-24T14:00:00Z"));
    expect(await events(t.id)).toEqual([]);
  });
});

describe("trade.sync dispatches a protected trade to syncProtectedTrade", () => {
  it("records the dispute for either trader, and never searches for a lock", async () => {
    const t = await protectedTrade(exitTrade(BUYER_EXIT), funded(BUYER_EXIT.steps));
    exitChain("buyer", "dispute");
    const lockSearch = vi.spyOn(horizon, "claimableBalances");
    const synced = await callerFor(d, BUYER_EXIT.accounts.seller).trade.sync({ tradeId: t.id });
    expect(synced).toMatchObject({ disputed: true, disputeOpenedBy: "buyer" });
    // Only the escrow's own calls were looked for: no lock search.
    expect(lockSearch).not.toHaveBeenCalled();
    expect(vi.mocked(horizon.operations).mock.results.length).toBeGreaterThan(0);
  });
});
