// The protected-trade report (WP-41) on pglite: every protected trade in each
// state, disputes in each stage of the rule, a resolution kept inside 72 hours,
// one at exactly 72 hours, one late, open disputes inside and past their 72
// hours, disputes closed by the testnet reset, and every resolution status.
// The report reads the database only; nothing here touches the chain.

import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { arbiterResolutions, chatMessages, disputeAnswers, tradeEvents, trades, users } from "@/lib/db/schema";
import { createTestDb } from "@/lib/db/test-setup";
import { ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { TW_FEE_ADDRESS } from "@/lib/escrow/config";
import { tradeFixture } from "@/lib/trade/test-helpers";

import { protectedReport, protectedReportMarkdown, type ProtectedReport } from "./protected-report";

const NOW = new Date("2026-12-18T10:00:00Z");
const OMER = "GDRJ7JMJPBAGHKLP5JZJ6S6CP3OZ2ZURM23RBHR2N56MDOFSOOLQLD5Q";
const ENSAR = "GDH2MGKJYMEZEHR62RRFYGHHK74AQ2AFZKUEP6GWCK5BRFB2A3T2N6J7";
const d = (iso: string) => new Date(iso);

/** A transaction hash per trade (n) and step: 64 hex characters. */
const STEP = { create: "1", fund: "2", release: "3", dispute: "4", resolve: "5", other: "6" } as const;
const hash = (n: number, step: keyof typeof STEP) => `${STEP[step]}${n.toString(16).padStart(3, "0")}`.repeat(16);
const contract = (n: number) => `C${String.fromCharCode(64 + n).repeat(55)}`;

let f: Awaited<ReturnType<typeof tradeFixture>>;
let order = 0;

type Insert = typeof trades.$inferInsert;
type Said = { cash: boolean; at: string };

/** A protected trade written straight to the table, opened a minute after the previous one. */
async function seed(values: Partial<Insert>, answers: { seller?: Said; buyer?: Said } = {}) {
  const [t] = await f.db
    .insert(trades)
    .values({
      listingId: f.listing.id,
      seller: f.owner,
      buyer: f.taker,
      openedBy: "buyer",
      mode: "protected",
      asset: "USDC",
      amount: "5",
      fiatCode: "TRY",
      fiatAmount: "205.00",
      windowSeconds: 0,
      acceptanceVersion: ACCEPTANCE_VERSION,
      buyerAcceptedAt: d("2026-11-01T00:00:00Z"),
      sellerAcceptedAt: d("2026-11-01T00:00:00Z"),
      createdAt: new Date(Date.parse("2026-11-01T00:00:00Z") + order++ * 60_000),
      ...values,
    })
    .returning();
  for (const role of ["seller", "buyer"] as const) {
    const a = answers[role];
    if (a) {
      await f.db
        .insert(disputeAnswers)
        .values({ tradeId: t.id, role, cashHandedOver: a.cash, answeredAt: d(a.at), note: `NOTE-SECRET by the ${role}` });
    }
  }
  return t;
}

const escrowed = (n: number): Partial<Insert> => ({
  state: "escrow_created",
  escrowAdmin: "GCREATION".padEnd(56, "A"),
  escrowContractId: contract(n),
  createTx: hash(n, "create"),
});
const funded = (n: number, at = "2026-11-02T00:00:00Z"): Partial<Insert> => ({
  ...escrowed(n),
  state: "funded",
  fundTx: hash(n, "fund"),
  fundedAt: d(at),
});
/** Disputed at `at` (the ledger time), recorded by Pairy `recordedAfter` seconds later. */
const disputed = (n: number, at: string, by: "seller" | "buyer" = "buyer", recordedAfter = 5): Partial<Insert> => ({
  ...funded(n),
  disputed: true,
  disputeTx: hash(n, "dispute"),
  disputedAt: d(at),
  disputeRecordedAt: new Date(Date.parse(at) + recordedAfter * 1000),
  disputeOpenedBy: by,
});
const resolved = (n: number, to: "buyer" | "seller", at: string | null): Partial<Insert> => ({
  state: to === "buyer" ? "resolved_buyer" : "resolved_seller",
  resolveTx: hash(n, "resolve"),
  resolvedAt: at === null ? null : d(at),
});

type ResolutionInsert = typeof arbiterResolutions.$inferInsert;
async function resolution(tradeId: string, values: Partial<ResolutionInsert> & Pick<ResolutionInsert, "txHash">) {
  const [r] = await f.db
    .insert(arbiterResolutions)
    .values({
      tradeId,
      outcome: "seller",
      rule: 3,
      recipient: f.owner,
      amount: "5",
      unsignedXdr: "UNSIGNED-XDR",
      signedXdr: "SIGNED-XDR",
      preparedBy: OMER,
      ...values,
    })
    .returning();
  return r;
}

/** What transitionTrade writes when scripts/ops/testnet-reset.ts closes a trade (persist.ts, testnet-reset.ts). */
async function reset<T extends { id: string }>(t: T, at = "2026-12-16T18:00:00Z") {
  await f.db.insert(tradeEvents).values({ tradeId: t.id, type: "reset", by: "system", createdAt: d(at) });
  return t;
}

beforeEach(async () => {
  f = await tradeFixture("sell_crypto", "USDC");
  order = 0;
});

/** Every protected state, every stage of a dispute and every resolution status the table allows at once. */
async function seedAll() {
  const t = {
    listed: await seed({ state: "listed", sellerAcceptedAt: null }),
    agreed: await seed({ state: "agreed" }),
    escrowCreated: await seed(escrowed(3)),
    funded: await seed(funded(4)),
    released: await seed({ ...funded(5), state: "released", releaseTx: hash(5, "release") }),
    cancelled: await seed({ state: "cancelled" }),
    // Disputed two hours ago; only the buyer has answered and the 24 hours are not over.
    waiting: await seed(disputed(7, "2026-12-18T08:00:00Z"), { buyer: { cash: true, at: "2026-12-18T09:00:00Z" } }),
    // Disputed 80 hours ago, both answered, still not resolved: the promise is missed.
    missedOpen: await seed(disputed(8, "2026-12-15T02:00:00Z", "seller", 10), {
      seller: { cash: false, at: "2026-12-15T03:00:00Z" },
      buyer: { cash: true, at: "2026-12-15T04:00:00Z" },
    }),
    // Rule 1, resolved five hours after the dispute.
    kept: await seed({ ...disputed(9, "2026-12-10T10:00:00Z", "seller"), ...resolved(9, "buyer", "2026-12-10T15:00:00Z") }, {
      seller: { cash: true, at: "2026-12-10T11:00:00Z" },
    }),
    // Rule 3, resolved 74 h 30 min after the dispute: late.
    late: await seed({ ...disputed(10, "2026-12-05T12:00:00Z"), ...resolved(10, "seller", "2026-12-08T14:30:00Z") }, {
      seller: { cash: false, at: "2026-12-05T13:00:00Z" },
    }),
    // Rule 2, resolved exactly 72 hours after the dispute: kept.
    exactly72: await seed({ ...disputed(11, "2026-12-01T09:00:00Z"), ...resolved(11, "buyer", "2026-12-04T09:00:00Z") }, {
      buyer: { cash: true, at: "2026-12-01T10:00:00Z" },
    }),
    // The rule gives the seller, the chain paid the buyer, and the resolve's ledger time was not recorded.
    offRule: await seed({ ...disputed(12, "2026-12-02T09:00:00Z"), ...resolved(12, "buyer", null) }, {
      seller: { cash: false, at: "2026-12-02T10:00:00Z" },
      buyer: { cash: true, at: "2026-12-02T10:30:00Z" },
    }),
    // A claimable trade's flag: not a protected trade, never in the report.
    claimable: await seed({
      mode: "claimable",
      acceptanceVersion: null,
      state: "locked",
      disputed: true,
      balanceId: "0".repeat(72),
      lockTx: "a".repeat(64),
      windowSeconds: 259_200,
    }),
    // Resolved, with the dispute's transaction but none of its times recorded.
    noTimes: await seed({ ...funded(14), disputeTx: hash(14, "dispute"), ...resolved(14, "seller", "2026-12-03T09:00:00Z") }),
    // Closed by the testnet reset 632 hours after its dispute, never resolved: the promise was missed.
    endedLate: await reset(await seed({ ...disputed(15, "2026-11-20T10:00:00Z"), state: "cancelled", updatedAt: d("2026-12-16T18:00:00Z") })),
    // Closed by the testnet reset 10 hours after its dispute: never resolved, so the promise was missed too (O-35).
    endedInside: await reset(await seed({ ...disputed(16, "2026-12-16T08:00:00Z"), state: "cancelled", updatedAt: d("2026-12-16T18:00:00Z") })),
  };
  const r = {
    failed: await resolution(t.missedOpen.id, {
      txHash: hash(8, "other"),
      status: "failed",
      signers: [OMER, ENSAR],
      createdAt: d("2026-12-18T00:00:00Z"),
      expiresAt: d("2026-12-18T01:00:00Z"),
    }),
    collecting: await resolution(t.missedOpen.id, {
      txHash: hash(8, "resolve"),
      signers: [OMER],
      createdAt: d("2026-12-18T09:30:00Z"),
      expiresAt: d("2026-12-18T10:30:00Z"),
    }),
    expired: await resolution(t.kept.id, {
      outcome: "buyer",
      rule: 1,
      recipient: f.taker,
      txHash: hash(9, "other"),
      status: "expired",
      createdAt: d("2026-12-10T11:30:00Z"),
      expiresAt: d("2026-12-10T12:30:00Z"),
    }),
    submitted: await resolution(t.kept.id, {
      outcome: "buyer",
      rule: 1,
      recipient: f.taker,
      txHash: hash(9, "resolve"),
      status: "submitted",
      submittedTx: hash(9, "resolve"),
      signers: [OMER, ENSAR],
      preparedBy: ENSAR,
      createdAt: d("2026-12-10T14:00:00Z"),
      expiresAt: d("2026-12-10T15:00:00Z"),
    }),
    // Marked expired by the stale rules, yet it is the resolve the chain shows (WP-29 deviation 7).
    expiredButLanded: await resolution(t.late.id, {
      txHash: hash(10, "resolve"),
      status: "expired",
      signers: [ENSAR, OMER],
      createdAt: d("2026-12-08T13:45:00Z"),
      expiresAt: d("2026-12-08T14:45:00Z"),
    }),
  };
  await f.db.insert(chatMessages).values({ tradeId: t.missedOpen.id, author: f.owner, body: "CHAT-SECRET: meet at the cafe" });
  return { t, r };
}

const report = (threshold: number | null = 2) => protectedReport(f.db, { now: NOW, threshold });
const tradeIn = (r: ProtectedReport, id: string) => r.trades.find((x) => x.id === id)!;

describe("protectedReport", () => {
  it("lists every protected trade, oldest first, and no claimable trade", async () => {
    const { t } = await seedAll();
    const r = await report();
    expect(r.trades.map((x) => x.id)).toEqual(
      [
        t.listed,
        t.agreed,
        t.escrowCreated,
        t.funded,
        t.released,
        t.cancelled,
        t.waiting,
        t.missedOpen,
        t.kept,
        t.late,
        t.exactly72,
        t.offRule,
        t.noTimes,
        t.endedLate,
        t.endedInside,
      ].map((x) => x.id),
    );
    expect(r.trades.map((x) => x.state)).toEqual([
      "listed",
      "agreed",
      "escrow_created",
      "funded",
      "released",
      "cancelled",
      "funded",
      "funded",
      "resolved_buyer",
      "resolved_seller",
      "resolved_buyer",
      "resolved_buyer",
      "resolved_seller",
      "cancelled",
      "cancelled",
    ]);
    expect(r).toMatchObject({ generatedAt: NOW, threshold: 2, feeAddress: TW_FEE_ADDRESS });
  });

  it("gives each trade its escrow viewer link and a stellar.expert link per recorded step, null where none is recorded", async () => {
    const { t } = await seedAll();
    const r = await report();
    const released = tradeIn(r, t.released.id);
    expect(released).toMatchObject({
      amount: "5.0000000",
      seller: f.owner,
      buyer: f.taker,
      contractId: contract(5),
      viewerUrl: `https://viewer.trustlesswork.com/testnet/v2/${contract(5)}`,
      fundedAt: d("2026-11-02T00:00:00Z"),
      dispute: null,
    });
    expect(released.steps).toEqual({
      create: { hash: hash(5, "create"), url: `https://stellar.expert/explorer/testnet/tx/${hash(5, "create")}` },
      fund: { hash: hash(5, "fund"), url: `https://stellar.expert/explorer/testnet/tx/${hash(5, "fund")}` },
      release: { hash: hash(5, "release"), url: `https://stellar.expert/explorer/testnet/tx/${hash(5, "release")}` },
      dispute: null,
      resolve: null,
    });
    expect(tradeIn(r, t.listed.id)).toMatchObject({
      contractId: null,
      viewerUrl: null,
      fundedAt: null,
      steps: { create: null, fund: null, release: null, dispute: null, resolve: null },
      dispute: null,
      resolutions: [],
    });
  });

  it("gives each dispute its times and both answers with when they were given; the rule only once it applies", async () => {
    const { t } = await seedAll();
    const r = await report();
    expect(tradeIn(r, t.waiting.id).dispute).toMatchObject({
      openedBy: "buyer",
      disputedAt: d("2026-12-18T08:00:00Z"),
      recordedAt: d("2026-12-18T08:00:05Z"),
      answersDue: d("2026-12-19T08:00:05Z"),
      promisedBy: d("2026-12-21T08:00:00Z"),
      answers: { seller: null, buyer: { cashHandedOver: true, answeredAt: d("2026-12-18T09:00:00Z") } },
      rule: null,
      resolvedTo: null,
      resolvedAt: null,
      followsRule: null,
    });
    expect(tradeIn(r, t.missedOpen.id).dispute).toMatchObject({
      openedBy: "seller",
      recordedAt: d("2026-12-15T02:00:10Z"),
      answers: {
        seller: { cashHandedOver: false, answeredAt: d("2026-12-15T03:00:00Z") },
        buyer: { cashHandedOver: true, answeredAt: d("2026-12-15T04:00:00Z") },
      },
      rule: { outcome: "seller", rule: 3 },
      resolvedTo: null,
    });
    // A trade that ended has its final answers: a missing one is no answer.
    expect(tradeIn(r, t.kept.id).dispute).toMatchObject({
      answers: { seller: { cashHandedOver: true }, buyer: null },
      rule: { outcome: "buyer", rule: 1 },
      resolvedTo: "buyer",
      resolvedAt: d("2026-12-10T15:00:00Z"),
      followsRule: true,
    });
    expect(tradeIn(r, t.exactly72.id).dispute).toMatchObject({ rule: { outcome: "buyer", rule: 2 }, resolvedTo: "buyer", followsRule: true });
    expect(tradeIn(r, t.late.id).dispute).toMatchObject({ rule: { outcome: "seller", rule: 3 }, resolvedTo: "seller", followsRule: true });
    // The chain paid the buyer where the rule gives the seller: shown, not hidden.
    expect(tradeIn(r, t.offRule.id).dispute).toMatchObject({ rule: { outcome: "seller", rule: 3 }, resolvedTo: "buyer", followsRule: false });
  });

  it("applies the rule to an open dispute once its 24 hours are over, a missing answer counting as none", async () => {
    const waiting = await seed(disputed(7, "2026-12-17T08:00:00Z"), { buyer: { cash: true, at: "2026-12-17T09:00:00Z" } });
    const r = await report();
    // Recorded 2026-12-17 08:00:05; at 2026-12-18 10:00 the window is over: seller none, buyer yes → rule 2.
    expect(tradeIn(r, waiting.id).dispute).toMatchObject({ rule: { outcome: "buyer", rule: 2 }, resolvedTo: null, followsRule: null });
  });

  it("checks the 72-hour promise: kept, late, open, missed, closed by the reset after or inside it, and not recorded", async () => {
    const { t } = await seedAll();
    const r = await report();
    const promise = (id: string) => {
      const x = tradeIn(r, id).dispute!;
      return { promise: x.promise, tookMs: x.tookMs };
    };
    const H = 3_600_000;
    expect(promise(t.kept.id)).toEqual({ promise: "kept", tookMs: 5 * H });
    expect(promise(t.exactly72.id)).toEqual({ promise: "kept", tookMs: 72 * H });
    expect(promise(t.late.id)).toEqual({ promise: "late", tookMs: 74.5 * H });
    expect(promise(t.waiting.id)).toEqual({ promise: "open", tookMs: 2 * H });
    expect(promise(t.missedOpen.id)).toEqual({ promise: "missed", tookMs: 80 * H });
    expect(promise(t.endedLate.id)).toEqual({ promise: "missed", tookMs: 632 * H });
    expect(promise(t.endedInside.id)).toEqual({ promise: "missed", tookMs: 10 * H });
    expect(tradeIn(r, t.endedLate.id).resetAt).toEqual(d("2026-12-16T18:00:00Z"));
    expect(tradeIn(r, t.endedInside.id).resetAt).toEqual(d("2026-12-16T18:00:00Z"));
    expect(tradeIn(r, t.cancelled.id).resetAt).toBeNull();
    // No resolve time, or no dispute time: nothing to measure.
    expect(promise(t.offRule.id)).toEqual({ promise: null, tookMs: null });
    expect(promise(t.noTimes.id)).toEqual({ promise: null, tookMs: null });
    expect(tradeIn(r, t.noTimes.id).dispute).toMatchObject({
      openedBy: null,
      disputedAt: null,
      recordedAt: null,
      answersDue: null,
      promisedBy: null,
      rule: { outcome: "seller", rule: 3 },
      resolvedTo: "seller",
      followsRule: true,
    });
  });

  it("is late one second past 72 hours", async () => {
    const t = await seed({ ...disputed(1, "2026-12-01T09:00:00Z"), ...resolved(1, "seller", "2026-12-04T09:00:01Z") });
    expect(tradeIn(await report(), t.id).dispute).toMatchObject({ promise: "late", tookMs: 72 * 3_600_000 + 1000 });
  });

  it("shows each resolution prepared in Pairy, oldest first, with its hash and a link only once it landed", async () => {
    const { t, r: rows } = await seedAll();
    const r = await report();
    expect(tradeIn(r, t.missedOpen.id).resolutions).toEqual([
      {
        id: rows.failed.id,
        status: "failed",
        stored: "failed",
        outcome: "seller",
        rule: 3,
        recipient: f.owner,
        amount: "5.0000000",
        net: "4.985",
        txHash: hash(8, "other"),
        url: null,
        signers: [OMER, ENSAR],
        preparedBy: OMER,
        preparedAt: d("2026-12-18T00:00:00Z"),
        validUntil: d("2026-12-18T01:00:00Z"),
      },
      expect.objectContaining({ id: rows.collecting.id, status: "collecting", stored: "collecting", signers: [OMER], url: null }),
    ]);
    expect(tradeIn(r, t.kept.id).resolutions).toEqual([
      expect.objectContaining({ id: rows.expired.id, status: "expired", signers: [], url: null }),
      expect.objectContaining({
        id: rows.submitted.id,
        status: "landed",
        stored: "submitted",
        txHash: hash(9, "resolve"),
        url: `https://stellar.expert/explorer/testnet/tx/${hash(9, "resolve")}`,
        preparedBy: ENSAR,
      }),
    ]);
    expect(tradeIn(r, t.late.id).resolutions).toEqual([
      expect.objectContaining({ id: rows.expiredButLanded.id, status: "landed", stored: "expired" }),
    ]);
  });

  describe("the one resolution being signed", () => {
    const at = (iso: string) => d(iso);
    it.each([
      { name: "no signature yet", signers: [], threshold: 2, expiresAt: at("2026-12-18T10:30:00Z"), status: "prepared" },
      { name: "one of two", signers: [OMER], threshold: 2, expiresAt: at("2026-12-18T10:30:00Z"), status: "collecting" },
      { name: "every signature, not on chain", signers: [OMER, ENSAR], threshold: 2, expiresAt: at("2026-12-18T10:30:00Z"), status: "signed" },
      { name: "two signatures, threshold unknown", signers: [OMER, ENSAR], threshold: null, expiresAt: at("2026-12-18T10:30:00Z"), status: "collecting" },
      { name: "its window closed, not yet marked", signers: [OMER], threshold: 2, expiresAt: at("2026-12-18T10:00:00Z"), status: "expired" },
      { name: "no expiry, made 11 minutes ago (F-11)", signers: [], threshold: 2, expiresAt: null, createdAt: at("2026-12-18T09:49:00Z"), status: "expired" },
      { name: "no expiry, made 9 minutes ago (F-11)", signers: [], threshold: 2, expiresAt: null, createdAt: at("2026-12-18T09:51:00Z"), status: "prepared" },
    ] as const)("$name → $status", async ({ signers, threshold, expiresAt, status, ...rest }) => {
      const t = await seed(disputed(1, "2026-12-18T08:00:00Z"));
      const row = await resolution(t.id, {
        txHash: hash(1, "resolve"),
        signers: [...signers],
        expiresAt,
        createdAt: "createdAt" in rest ? rest.createdAt : at("2026-12-18T09:30:00Z"),
      });
      const [x] = tradeIn(await protectedReport(f.db, { now: NOW, threshold }), t.id).resolutions;
      expect(x).toMatchObject({ id: row.id, status, stored: "collecting", url: null });
      if (expiresAt === null) expect(x.validUntil).toEqual(new Date(row.createdAt.getTime() + 10 * 60_000));
    });

    it("is expired when Pairy marked it so inside its window (the arbiter's sequence moved on, WP-29)", async () => {
      const t = await seed(disputed(1, "2026-12-18T08:00:00Z"));
      await resolution(t.id, { txHash: hash(1, "resolve"), status: "expired", signers: [OMER], expiresAt: d("2026-12-18T10:30:00Z") });
      const [x] = tradeIn(await report(), t.id).resolutions;
      expect(x).toMatchObject({ status: "expired", stored: "expired", url: null });
    });

    it("is landed when the trade's sync recorded its resolve and the row was never marked (WP-29 N6)", async () => {
      const t = await seed({ ...disputed(1, "2026-12-18T08:00:00Z"), ...resolved(1, "seller", "2026-12-18T09:40:00Z") });
      await resolution(t.id, { txHash: hash(1, "resolve"), signers: [OMER, ENSAR], expiresAt: d("2026-12-18T10:30:00Z") });
      const [x] = tradeIn(await report(), t.id).resolutions;
      expect(x).toMatchObject({ status: "landed", stored: "collecting", url: `https://stellar.expert/explorer/testnet/tx/${hash(1, "resolve")}` });
    });
  });

  it("never reads the notes or the chat", async () => {
    await seedAll();
    const r = await report();
    const out = JSON.stringify(r) + protectedReportMarkdown(r);
    expect(out).not.toMatch(/NOTE-SECRET|CHAT-SECRET/);
    expect(out).not.toMatch(/UNSIGNED-XDR|SIGNED-XDR/);
  });

  it("leaves the database as it was", async () => {
    await seedAll();
    const everything = async () =>
      Promise.all([
        f.db.select().from(trades).orderBy(trades.id),
        f.db.select().from(disputeAnswers).orderBy(disputeAnswers.tradeId, disputeAnswers.role),
        f.db.select().from(arbiterResolutions).orderBy(arbiterResolutions.id),
        f.db.select().from(chatMessages).orderBy(chatMessages.id),
        f.db.select().from(tradeEvents).orderBy(tradeEvents.id),
        f.db.select().from(users).orderBy(users.publicKey),
      ]);
    const before = await everything();
    await report();
    expect(await everything()).toEqual(before);
  });

  it("reads in a transaction Postgres keeps read only", async () => {
    await seedAll();
    const transaction = f.db.transaction.bind(f.db);
    let refused: unknown = null;
    vi.spyOn(f.db, "transaction").mockImplementation(((run: (tx: unknown) => Promise<unknown>, config: unknown) =>
      transaction(async (tx) => {
        const out = await run(tx);
        // A write in the report's own transaction: Postgres refuses it.
        refused = await tx
          .update(trades)
          .set({ state: "cancelled" })
          .then(() => null, (e: unknown) => e);
        return out;
      }, config as never)) as never);
    await report();
    expect(String((refused as { cause?: unknown })?.cause ?? refused)).toMatch(/read-only transaction/);
    expect((await f.db.select().from(trades).where(eq(trades.state, "cancelled"))).length).toBe(3);
  });

  it("reports an empty database without failing", async () => {
    const { db } = await createTestDb();
    const r = await protectedReport(db, { now: NOW, threshold: null });
    expect(r.trades).toEqual([]);
    expect(protectedReportMarkdown(r)).toContain("No protected trades.");
  });
});

describe("protectedReportMarkdown", () => {
  const id8 = (id: string) => `\`${id.slice(0, 8)}\``;
  const tx = (h: string) => `[\`${h.slice(0, 8)}…${h.slice(-4)}\`](https://stellar.expert/explorer/testnet/tx/${h})`;
  const acct = (k: string) => `[\`${k.slice(0, 4)}…${k.slice(-4)}\`](https://stellar.expert/explorer/testnet/account/${k})`;
  const viewer = (c: string) => `[\`${c.slice(0, 4)}…${c.slice(-4)}\`](https://viewer.trustlesswork.com/testnet/v2/${c})`;

  it("opens with the counts and the fee address", async () => {
    await seedAll();
    const md = protectedReportMarkdown(await report());
    expect(md.startsWith("# Protected trades\n\n")).toBe(true);
    expect(md).toContain("Generated 2026-12-18 10:00:00 UTC from Pairy's database, read only. 15 protected trades, 9 disputed, 5 resolved.");
    expect(md).toContain(`Trustless Work's fee address, which Pairy requires in every release and resolution it records: ${acct(TW_FEE_ADDRESS!)}.`);
  });

  it("lists every late or missed promise first, oldest dispute first, and the disputes it could not check", async () => {
    const { t } = await seedAll();
    const md = protectedReportMarkdown(await report());
    const late = md.slice(md.indexOf("## Late promises"), md.indexOf("## Disputes"));
    expect(late.split("\n").filter((l) => l.startsWith("| `"))).toEqual([
      `| ${id8(t.endedLate.id)} | 2026-11-20 10:00:00 UTC | 2026-11-23 10:00:00 UTC | not resolved; closed by the testnet reset on 2026-12-16 18:00:00 UTC | 560 h 0 min |`,
      `| ${id8(t.late.id)} | 2026-12-05 12:00:00 UTC | 2026-12-08 12:00:00 UTC | 2026-12-08 14:30:00 UTC, ${tx(hash(10, "resolve"))} | 2 h 30 min |`,
      `| ${id8(t.missedOpen.id)} | 2026-12-15 02:00:00 UTC | 2026-12-18 02:00:00 UTC | not resolved; still open | 8 h 0 min so far |`,
      `| ${id8(t.endedInside.id)} | 2026-12-16 08:00:00 UTC | 2026-12-19 08:00:00 UTC | not resolved; closed by the testnet reset on 2026-12-16 18:00:00 UTC | none: closed by the testnet reset before the deadline |`,
    ]);
    expect(late).toContain(`Not checked, a time is not recorded: ${id8(t.offRule.id)}, ${id8(t.noTimes.id)}.`);
  });

  it("says so when no promise was missed", async () => {
    await seed({ ...disputed(1, "2026-12-10T10:00:00Z"), ...resolved(1, "buyer", "2026-12-10T15:00:00Z") }, { seller: { cash: true, at: "2026-12-10T11:00:00Z" } });
    const md = protectedReportMarkdown(await report());
    expect(md).toContain("None: every dispute was resolved within 72 hours of its ledger time, or is still inside them.");
    expect(md).not.toContain("Not checked");
  });

  it("says None only of the disputes it could check when some could not be", async () => {
    await seed({ ...disputed(1, "2026-12-10T10:00:00Z"), ...resolved(1, "buyer", "2026-12-10T15:00:00Z") }, { seller: { cash: true, at: "2026-12-10T11:00:00Z" } });
    const unchecked = await seed({ ...disputed(2, "2026-12-11T10:00:00Z"), ...resolved(2, "seller", null) });
    const md = protectedReportMarkdown(await report());
    expect(md).toContain("None among the disputes with recorded times: each was resolved within 72 hours of its ledger time, or is still inside them.");
    expect(md).not.toContain("None: every dispute");
    expect(md).toContain(`Not checked, a time is not recorded: ${id8(unchecked.id)}.`);
  });

  it("lists a dispute the testnet reset closed inside its 72 hours as missed, naming the reset", async () => {
    const t = await reset(await seed({ ...disputed(1, "2026-12-16T08:00:00Z"), state: "cancelled", updatedAt: d("2026-12-16T18:00:00Z") }));
    const md = protectedReportMarkdown(await report());
    const late = md.slice(md.indexOf("## Late promises"), md.indexOf("## Disputes"));
    expect(late.split("\n").filter((l) => l.startsWith("| `"))).toEqual([
      `| ${id8(t.id)} | 2026-12-16 08:00:00 UTC | 2026-12-19 08:00:00 UTC | not resolved; closed by the testnet reset on 2026-12-16 18:00:00 UTC | none: closed by the testnet reset before the deadline |`,
    ]);
    expect(late).not.toContain("None");
    expect(md).toContain("| not resolved | missed: due 2026-12-19 08:00:00 UTC; closed by the testnet reset on 2026-12-16 18:00:00 UTC |");
  });

  it("says only that the trade ended when no reset is recorded for it", async () => {
    const t = await seed({ ...disputed(1, "2026-11-20T10:00:00Z"), state: "cancelled", updatedAt: d("2026-12-16T18:00:00Z") });
    // Its other events are not a reset.
    await f.db.insert(tradeEvents).values([
      { tradeId: t.id, type: "open", by: "buyer", createdAt: d("2026-11-01T00:00:00Z") },
      { tradeId: t.id, type: "cancel", by: "seller", createdAt: d("2026-12-16T18:00:00Z") },
    ]);
    const r = await report();
    expect(tradeIn(r, t.id)).toMatchObject({ resetAt: null, dispute: { promise: "missed", tookMs: 632 * 3_600_000 } });
    const md = protectedReportMarkdown(r);
    expect(md).toContain(`| ${id8(t.id)} | 2026-11-20 10:00:00 UTC | 2026-11-23 10:00:00 UTC | not resolved; the trade ended cancelled on 2026-12-16 18:00:00 UTC | 560 h 0 min |`);
    expect(md).toContain("| not resolved | missed: due 2026-11-23 10:00:00 UTC; the trade ended cancelled on 2026-12-16 18:00:00 UTC |");
    // The rows name no reason the database does not hold.
    expect(md.split("\n").filter((l) => l.startsWith("| `")).join("\n")).not.toContain("reset");
  });

  it("writes one row per dispute: times, both answers, the rule, the outcome and the promise", async () => {
    const { t } = await seedAll();
    const md = protectedReportMarkdown(await report());
    const rows = md.slice(md.indexOf("## Disputes"), md.indexOf("## Resolutions prepared in Pairy")).split("\n");
    const rowOf = (id: string) => rows.find((l) => l.startsWith(`| ${id8(id)} |`));
    expect(rowOf(t.kept.id)).toBe(
      `| ${id8(t.kept.id)} | ${viewer(contract(9))} | seller, ${tx(hash(9, "dispute"))} | 2026-12-10 10:00:00 UTC | 2026-12-10 10:00:05 UTC | yes, 2026-12-10 11:00:00 UTC | no answer | 1: all to the buyer | all to the buyer, 2026-12-10 15:00:00 UTC, ${tx(hash(9, "resolve"))}; follows rule 1 | kept: 5 h 0 min |`,
    );
    expect(rowOf(t.waiting.id)).toBe(
      `| ${id8(t.waiting.id)} | ${viewer(contract(7))} | buyer, ${tx(hash(7, "dispute"))} | 2026-12-18 08:00:00 UTC | 2026-12-18 08:00:05 UTC | not yet | yes, 2026-12-18 09:00:00 UTC | waiting for answers until 2026-12-19 08:00:05 UTC | not resolved | open: due 2026-12-21 08:00:00 UTC |`,
    );
    expect(rowOf(t.late.id)).toContain("| late: 74 h 30 min, due 2026-12-08 12:00:00 UTC |");
    expect(rowOf(t.missedOpen.id)).toContain("| 3: all back to the seller | not resolved | missed: due 2026-12-18 02:00:00 UTC |");
    expect(rowOf(t.offRule.id)).toContain(`| all to the buyer, not recorded, ${tx(hash(12, "resolve"))}; does not follow rule 3 | not recorded |`);
    expect(rowOf(t.noTimes.id)).toBe(
      `| ${id8(t.noTimes.id)} | ${viewer(contract(14))} | not recorded, ${tx(hash(14, "dispute"))} | not recorded | not recorded | no answer | no answer | 3: all back to the seller | all back to the seller, 2026-12-03 09:00:00 UTC, ${tx(hash(14, "resolve"))}; follows rule 3 | not recorded |`,
    );
    expect(rowOf(t.endedLate.id)).toContain(
      "| not resolved | missed: due 2026-11-23 10:00:00 UTC; closed by the testnet reset on 2026-12-16 18:00:00 UTC |",
    );
    expect(rowOf(t.endedInside.id)).toContain(
      "| not resolved | missed: due 2026-12-19 08:00:00 UTC; closed by the testnet reset on 2026-12-16 18:00:00 UTC |",
    );
    expect(rowOf(t.funded.id)).toBeUndefined();
  });

  it("writes one row per resolution prepared in Pairy, in the order they were prepared: status, what the payee receives (HD-3 paid 4.985 of 5), signatures", async () => {
    const { t } = await seedAll();
    const md = protectedReportMarkdown(await report());
    const rows = md.slice(md.indexOf("## Resolutions prepared in Pairy"), md.indexOf("## Every protected trade")).split("\n");
    expect(rows.filter((l) => l.startsWith("| `"))).toEqual([
      `| ${id8(t.late.id)} | ${tx(hash(10, "resolve"))} | landed | 4.985 USDC to the seller ${acct(f.owner)} (5 USDC less Trustless Work's 0.3%), rule 3 | 2 of 2: \`GDH2…N6J7\`, \`GDRJ…LD5Q\` | 2026-12-08 13:45:00 UTC by \`GDRJ…LD5Q\` | 2026-12-08 14:45:00 UTC |`,
      `| ${id8(t.kept.id)} | \`${hash(9, "other").slice(0, 8)}…${hash(9, "other").slice(-4)}\` | expired | 4.985 USDC to the buyer ${acct(f.taker)} (5 USDC less Trustless Work's 0.3%), rule 1 | 0 of 2 | 2026-12-10 11:30:00 UTC by \`GDRJ…LD5Q\` | 2026-12-10 12:30:00 UTC |`,
      `| ${id8(t.kept.id)} | ${tx(hash(9, "resolve"))} | landed | 4.985 USDC to the buyer ${acct(f.taker)} (5 USDC less Trustless Work's 0.3%), rule 1 | 2 of 2: \`GDRJ…LD5Q\`, \`GDH2…N6J7\` | 2026-12-10 14:00:00 UTC by \`GDH2…N6J7\` | 2026-12-10 15:00:00 UTC |`,
      `| ${id8(t.missedOpen.id)} | \`${hash(8, "other").slice(0, 8)}…${hash(8, "other").slice(-4)}\` | failed | 4.985 USDC to the seller ${acct(f.owner)} (5 USDC less Trustless Work's 0.3%), rule 3 | 2 of 2: \`GDRJ…LD5Q\`, \`GDH2…N6J7\` | 2026-12-18 00:00:00 UTC by \`GDRJ…LD5Q\` | 2026-12-18 01:00:00 UTC |`,
      `| ${id8(t.missedOpen.id)} | \`${hash(8, "resolve").slice(0, 8)}…${hash(8, "resolve").slice(-4)}\` | collecting | 4.985 USDC to the seller ${acct(f.owner)} (5 USDC less Trustless Work's 0.3%), rule 3 | 1 of 2: \`GDRJ…LD5Q\` | 2026-12-18 09:30:00 UTC by \`GDRJ…LD5Q\` | 2026-12-18 10:30:00 UTC |`,
    ]);
  });

  it("says the threshold was not read when Horizon could not be read", async () => {
    await seedAll();
    const md = protectedReportMarkdown(await report(null));
    expect(md).toContain("The arbiter account's threshold could not be read from Horizon, so a resolution with every signature shows as collecting.");
    expect(md).toContain("| 1 (threshold not read): `GDRJ…LD5Q` |");
  });

  it("lists every protected trade with its links, not recorded where a step has none", async () => {
    const { t } = await seedAll();
    const md = protectedReportMarkdown(await report());
    const rows = md.slice(md.indexOf("## Every protected trade")).split("\n").filter((l) => l.startsWith("| `"));
    expect(rows).toHaveLength(15);
    expect(rows[0]).toBe(
      `| ${id8(t.listed.id)} | 2026-11-01 00:00:00 UTC | listed | 5 | ${acct(f.owner)} | ${acct(f.taker)} | not recorded | not recorded | not recorded | not recorded | not recorded | not recorded |`,
    );
    expect(rows[4]).toBe(
      `| ${id8(t.released.id)} | 2026-11-01 00:04:00 UTC | released | 5 | ${acct(f.owner)} | ${acct(f.taker)} | ${viewer(contract(5))} | ${tx(hash(5, "create"))} | ${tx(hash(5, "fund"))} | ${tx(hash(5, "release"))} | not recorded | not recorded |`,
    );
  });
});
