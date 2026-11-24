// The arbiter router (D2 §5.3, FIXES F-03, O-17) on pglite, on the day-12
// gate's two real-arbiter exits (HD-3): Trustless Work's resolve as it answered
// (tests/fixtures/tw/exits-real-resolve-*.json), re-timed by the server as
// escrow-exits.ts re-timed it, and Ömer's and Ensar's real signatures on it.
// Horizon is faked from tests/fixtures/horizon/wp15-disputes.json (the landed
// resolves) and the arbiter account as the run read it; Soroban RPC answers
// with the values the run read; Trustless Work is mocked. validateEscrowCall,
// rebuildMaxTime, the signature extraction and merge, and verifyEscrowTx all
// run for real.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Keypair, Networks, NotFoundError, TransactionBuilder, xdr, type Transaction } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { arbiterResolutions, chatMessages, disputeAnswers, listings, trades, users } from "@/lib/db/schema";
import { createTestDb } from "@/lib/db/test-setup";
import { ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { ARBITER_ACCOUNT, TW_FEE_ADDRESS } from "@/lib/escrow/config";
import { EscrowNotFoundError, readCodeTtl, readEscrow } from "@/lib/escrow/read";
import { expectedTerms } from "@/lib/escrow/terms";
import { rebuildMaxTime } from "@/lib/escrow/xdr";
import { horizon, networkDeadline } from "@/lib/stellar/horizon";
import { transitionTrade } from "@/lib/trade/persist";
import { callerFor } from "@/lib/trade/test-helpers";
import { arbiterAccountNow } from "@/server/api/arbiter-auth";
import { TwApiError, twCall } from "@/server/tw/client";

vi.mock("@/server/tw/client", async (orig) => ({ ...(await orig<typeof import("@/server/tw/client")>()), twCall: vi.fn() }));
vi.mock("@/lib/escrow/read", async (orig) => ({
  ...(await orig<typeof import("@/lib/escrow/read")>()),
  readEscrow: vi.fn(),
  readCodeTtl: vi.fn(),
}));
vi.mock("@/lib/stellar/horizon", async (orig) => ({ ...(await orig<typeof import("@/lib/stellar/horizon")>()), networkDeadline: vi.fn() }));
vi.mock("@/lib/escrow/xdr", async (orig) => ({ ...(await orig<typeof import("@/lib/escrow/xdr")>()), rebuildMaxTime: vi.fn() }));
const actualXdr = await vi.importActual<typeof import("@/lib/escrow/xdr")>("@/lib/escrow/xdr");

const OMER = "GDRJ7JMJPBAGHKLP5JZJ6S6CP3OZ2ZURM23RBHR2N56MDOFSOOLQLD5Q";
const ENSAR = "GDH2MGKJYMEZEHR62RRFYGHHK74AQ2AFZKUEP6GWCK5BRFB2A3T2N6J7";

/** One HD-3 resolve as escrow-exits.ts recorded it (track-a 5e4cbc2, scripts/evidence/out/escrow-dispute-*-real.json). */
type Resolve = {
  at: string;
  request: { body: { contractId: string; disputeResolver: string; distributions: { address: string; amount: number }[] } };
  response: { body: { unsignedXdr: string; txHash: string } };
  escrow: { contractId: string; seller: string; buyer: string; disputer: "buyer" | "seller"; recipient: string };
  escrowTtl: { liveUntilLedgerSeq: number; latestLedger: number };
  arbiter: { sequence: string };
  rebuilt: { horizonTime: number; maxTime: number; unsignedXdr: string; txHash: string };
  signatures: { signer: string; receivedAt: string }[];
  singleSignatures: { signer: string; envelopeXdr: string; resultXdr: string }[];
  landed: { signedXdr: string; hash: string };
};
const fixture = (dir: string, name: string) => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures", dir, `${name}.json`), "utf8"));
/** The buyer exit: the buyer disputed and was paid. The seller exit: the seller disputed and got the USDC back. */
const EXIT: Record<"buyer" | "seller", Resolve> = { buyer: fixture("tw", "exits-real-resolve-buyer"), seller: fixture("tw", "exits-real-resolve-seller") };
const { buyer: BUYER_EXIT, seller: SELLER_EXIT } = EXIT;
/** WP-15's test-arbiter buyer exit: another transaction, signed by other keys. */
const TEST_RUN: Resolve = fixture("tw", "exits-test-resolve-buyer");

type Recorded = { hash: string; transaction: Record<string, any>; operations: Record<string, any>[] };
type Exit = { contractId: string; accounts: { creation: string; seller: string; buyer: string }; steps: Record<"deploy" | "fund" | "dispute" | "resolve", Recorded> };
const WP15: { exits: Record<"buyer" | "seller", Exit>; accounts: Record<string, Record<string, any>[]> } = fixture("horizon", "wp15-disputes");
const chainOf = (exit: Resolve) => (exit === SELLER_EXIT ? WP15.exits.seller : WP15.exits.buyer);

/** The copy a signer returned: the re-timed resolve with that signer's real signature alone (sent alone, testnet refused it). */
const copyBy = (exit: Resolve, signer: string) => exit.singleSignatures.find((s) => s.signer === signer)!;
const receivedAt = (exit: Resolve, signer: string) => Date.parse(exit.signatures.find((s) => s.signer === signer)!.receivedAt);

// ---- Horizon: the arbiter account, and the recorded transactions and operations ----
let arbiter: { sequence: string; thresholds: Record<string, number>; signers: { key: string; weight: number }[] };
/** The real arbiter as Horizon shows it (WP-05): Ömer and Ensar at weight 1, its own key at weight 0, thresholds 2/2/2. */
const onHorizon = (sequence: string, signers = [ENSAR, OMER].map((key) => ({ key, weight: 1 }))) => ({
  sequence,
  thresholds: { low_threshold: 2, med_threshold: 2, high_threshold: 2 },
  signers: [...signers, { key: ARBITER_ACCOUNT, weight: 0 }],
});
let horizonDown = false;
let txs: Record<string, Record<string, any>>;
let opsByTx: Record<string, Record<string, any>[]>;
let opsByAccount: Record<string, Record<string, any>[]>;

function fakeHorizon() {
  const steps = Object.values(WP15.exits).flatMap((e) => Object.values(e.steps));
  txs = Object.fromEntries(steps.map((s) => [s.hash, structuredClone(s.transaction)]));
  opsByTx = Object.fromEntries(steps.map((s) => [s.hash, structuredClone(s.operations)]));
  opsByAccount = structuredClone(WP15.accounts);
  vi.spyOn(horizon, "loadAccount").mockImplementation(async (id: string) => {
    // The signer keys are unfunded (O-7): only the arbiter account itself is ever loaded.
    if (id !== ARBITER_ACCOUNT) throw new Error(`unexpected Horizon account load: ${id}`);
    if (horizonDown) throw new Error("Request failed with status code 503");
    return structuredClone(arbiter) as never;
  });
  vi.spyOn(horizon, "transactions").mockReturnValue({
    transaction: (hash: string) => ({
      call: async () => {
        if (horizonDown) throw new Error("Request failed with status code 503");
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
}

// ---- Soroban RPC, as the runs read it ----
type Status = { disputed: boolean; released: boolean; resolved: boolean; balanceStroops: bigint };
type Ttl = { latestLedger: number; instanceLiveUntil: number; escrowLiveUntil: number | null };
const OPEN_DISPUTE: Status = { disputed: true, released: false, resolved: false, balanceStroops: 50_000_000n };
/** The escrow code's TTL (WP-14 judge: it lives until ledger 6,305,674). */
const CODE_LIVE_UNTIL = 6_305_674;

/** What readEscrow and readCodeTtl answer for an exit's escrow: by default its open dispute, with the TTLs the run read before preparing. */
function chainHas(exit: Resolve, status: Partial<Status> = {}, ttl: Partial<Ttl> = {}, codeLiveUntil = CODE_LIVE_UNTIL) {
  const { latestLedger, liveUntilLedgerSeq } = exit.escrowTtl;
  const e = chainOf(exit);
  vi.mocked(readEscrow).mockImplementation(async (id) => {
    if (id !== exit.escrow.contractId) throw new EscrowNotFoundError(id);
    return {
      terms: expectedTerms({ buyer: e.accounts.buyer, seller: e.accounts.seller, amount: "5", escrowAdmin: e.accounts.creation }),
      status: { ...OPEN_DISPUTE, ...status },
      ttl: { latestLedger, instanceLiveUntil: liveUntilLedgerSeq, escrowLiveUntil: liveUntilLedgerSeq, ...ttl },
    };
  });
  vi.mocked(readCodeTtl).mockResolvedValue({ latestLedger: ttl.latestLedger ?? latestLedger, liveUntil: codeLiveUntil });
}

/**
 * The moment Trustless Work answered this exit's resolve: the clock half a
 * second later, the arbiter on Horizon at the sequence it was prepared on, and
 * Horizon's clock as the run read it (networkDeadline is Horizon time + seconds).
 */
function atPrepare(exit: Resolve, answer: { unsignedXdr: string; txHash: string } = exit.response.body) {
  vi.setSystemTime(Date.parse(exit.at) + 500);
  arbiter = onHorizon(exit.arbiter.sequence);
  chainHas(exit);
  vi.mocked(twCall).mockResolvedValueOnce(answer as never);
  vi.mocked(networkDeadline).mockImplementation(async (seconds) => exit.rebuilt.horizonTime + seconds);
}

/** Trustless Work preparing the same resolve again at `when`: the recorded one, valid its usual 5 minutes from then; Horizon's clock agrees. */
function twAgain(exit: Resolve, when: number) {
  vi.setSystemTime(when);
  const nowS = Math.floor(when / 1000);
  vi.mocked(twCall).mockResolvedValueOnce(actualXdr.rebuildMaxTime(exit.response.body.unsignedXdr, nowS + 300) as never);
  vi.mocked(networkDeadline).mockImplementation(async (seconds) => nowS + seconds);
}

/** Trustless Work's resolve as it would have prepared it on another sequence: the recorded one with only its seqNum moved. */
function onSequence(prepared: { unsignedXdr: string }, sequence: bigint) {
  const env = xdr.TransactionEnvelope.fromXDR(prepared.unsignedXdr, "base64").toXdrObject();
  if (env.type !== 2) throw new Error("not a v1 envelope");
  const out = xdr.TransactionEnvelope.fromXdrObject({ ...env, v1: { ...env.v1, tx: { ...env.v1.tx, seqNum: sequence } } }).toXdr("base64");
  return { unsignedXdr: out, txHash: Buffer.from(TransactionBuilder.fromXDR(out, Networks.TESTNET).hash()).toString("hex") };
}

let log: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(BUYER_EXIT.at) + 500);
  horizonDown = false;
  arbiter = onHorizon(BUYER_EXIT.arbiter.sequence);
  fakeHorizon();
  chainHas(BUYER_EXIT);
  vi.mocked(twCall).mockReset().mockImplementation(async (ep) => {
    throw new Error(`unexpected Trustless Work call: ${ep}`);
  });
  vi.mocked(networkDeadline).mockReset().mockImplementation(async (seconds) => BUYER_EXIT.rebuilt.horizonTime + seconds);
  vi.mocked(rebuildMaxTime).mockReset().mockImplementation(actualXdr.rebuildMaxTime);
  // The signer list is cached for a minute; each test starts from the real account.
  await arbiterAccountNow();
  vi.mocked(horizon.loadAccount).mockClear();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- The database ----
async function setup() {
  const { db } = await createTestDb();
  const stranger = Keypair.random().publicKey();
  await db.insert(users).values({ publicKey: stranger });
  return { db, stranger, as: (pk: string | null) => callerFor(db, pk) };
}
let f: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  f = await setup();
});

type Answers = { seller?: boolean; buyer?: boolean };

/**
 * A funded protected trade on an exit's escrow, between its traders, with its
 * dispute recorded a minute after it landed (or `values` override), the given
 * answers (each with a note), and a chat. The listing has 95 of 100 left.
 */
async function disputedTrade(exit: Resolve, answers: Answers = {}, values: Partial<typeof trades.$inferInsert> = {}) {
  const e = chainOf(exit);
  const { seller, buyer, creation } = e.accounts;
  await f.db.insert(users).values([seller, buyer].map((publicKey) => ({ publicKey }))).onConflictDoNothing();
  const [listing] = await f.db
    .insert(listings)
    .values({
      owner: seller,
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
  const disputedAt = new Date(e.steps.dispute.transaction.created_at);
  const [t] = await f.db
    .insert(trades)
    .values({
      listingId: listing.id,
      seller,
      buyer,
      openedBy: "buyer",
      mode: "protected",
      asset: "USDC",
      amount: "5",
      fiatCode: "TRY",
      fiatAmount: "205.00",
      windowSeconds: 0,
      acceptanceVersion: ACCEPTANCE_VERSION,
      sellerAcceptedAt: new Date("2026-11-24T09:00:00Z"),
      buyerAcceptedAt: new Date("2026-11-24T09:00:00Z"),
      escrowAdmin: creation,
      escrowContractId: e.contractId,
      createTx: e.steps.deploy.hash,
      fundTx: e.steps.fund.hash,
      fundedAt: new Date(e.steps.fund.transaction.created_at),
      state: "funded",
      disputed: true,
      disputeTx: e.steps.dispute.hash,
      disputedAt,
      disputeRecordedAt: new Date(disputedAt.getTime() + 1_000),
      disputeOpenedBy: exit.escrow.disputer,
      ...values,
    })
    .returning();
  for (const role of ["seller", "buyer"] as const) {
    const a = answers[role];
    if (a !== undefined) await f.db.insert(disputeAnswers).values({ tradeId: t.id, role, cashHandedOver: a, note: `NOTE by the ${role}` });
  }
  await f.db.insert(chatMessages).values({ tradeId: t.id, author: seller, body: "CHAT: meet at the cafe" });
  return t;
}

/** A claimable trade whose trader flagged a dispute: Phase 1's flag, nothing for the arbiter. */
const CLAIMABLE_FLAGGED: Partial<typeof trades.$inferInsert> = {
  mode: "claimable",
  acceptanceVersion: null,
  state: "locked",
  escrowContractId: null,
  escrowAdmin: null,
  createTx: null,
  fundTx: null,
  fundedAt: null,
  disputeTx: null,
  disputedAt: null,
  disputeRecordedAt: null,
  disputeOpenedBy: null,
  balanceId: "0".repeat(72),
  lockTx: "a".repeat(64),
};

const row = async (id: string) => (await f.db.select().from(trades).where(eq(trades.id, id)))[0];
const resolutions = () => f.db.select().from(arbiterResolutions).orderBy(arbiterResolutions.createdAt);
const resolution = async (id: string) => (await f.db.select().from(arbiterResolutions).where(eq(arbiterResolutions.id, id)))[0];

/** Prepared by Ömer at the moment Trustless Work answered, as in HD-3. */
async function prepared(exit: Resolve, t: { id: string }) {
  atPrepare(exit);
  return f.as(OMER).arbiter.prepareResolution({ tradeId: t.id });
}

/** Each signer's copy, posted at the moment their signature arrived in HD-3, in that order. */
async function signedByBoth(exit: Resolve, resolutionId: string) {
  let out;
  for (const { signer } of exit.signatures) {
    vi.setSystemTime(receivedAt(exit, signer));
    out = await f.as(signer).arbiter.addSignature({ resolutionId, signedXdr: copyBy(exit, signer).envelopeXdr });
  }
  return out!;
}

const FORBIDDEN = { code: "FORBIDDEN", message: "This page is only for the arbiter account's signers." };

describe("arbiter: who may call it", () => {
  it("lets only a current signer of the arbiter account in; everyone else gets FORBIDDEN on every procedure", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const { resolutionId } = await prepared(BUYER_EXIT, t);
    const removed = Keypair.random().publicKey();
    arbiter = onHorizon(BUYER_EXIT.arbiter.sequence, [
      { key: ENSAR, weight: 1 },
      { key: OMER, weight: 1 },
      { key: removed, weight: 0 },
    ]);
    await arbiterAccountNow();

    // A stranger, the account's own key and a removed signer (both listed at weight 0), and a trader of the trade.
    for (const pk of [f.stranger, ARBITER_ACCOUNT, removed, chainOf(BUYER_EXIT).accounts.buyer]) {
      const as = f.as(pk).arbiter;
      await expect(as.list()).rejects.toMatchObject(FORBIDDEN);
      await expect(as.byId({ tradeId: t.id })).rejects.toMatchObject(FORBIDDEN);
      await expect(as.prepareResolution({ tradeId: t.id })).rejects.toMatchObject(FORBIDDEN);
      await expect(as.addSignature({ resolutionId, signedXdr: copyBy(BUYER_EXIT, ENSAR).envelopeXdr })).rejects.toMatchObject(FORBIDDEN);
      await expect(as.recordResolution({ tradeId: t.id, txHash: BUYER_EXIT.landed.hash })).rejects.toMatchObject(FORBIDDEN);
      expect(await as.me()).toEqual({ isSigner: false, threshold: 2, signers: [ENSAR, OMER] });
    }
    await expect(f.as(null).arbiter.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(f.as(null).arbiter.me()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(await f.as(OMER).arbiter.me()).toEqual({ isSigner: true, threshold: 2, signers: [ENSAR, OMER] });
    expect(await f.as(ENSAR).arbiter.list()).toHaveLength(1);
    // Nothing a refused caller sent reached the resolution.
    expect(await resolution(resolutionId)).toMatchObject({ status: "collecting", signers: [] });
  });

  it("fails closed when Horizon cannot show the signers: FORBIDDEN for every procedure, and me says why", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    // A day later, so the signer list cached a minute ago is gone.
    vi.setSystemTime(Date.parse(BUYER_EXIT.at) + 86_400_000);
    horizonDown = true;
    const down = { code: "FORBIDDEN", message: "Couldn't confirm the signer list. Try again." };
    const as = f.as(OMER).arbiter;
    await expect(as.list()).rejects.toMatchObject(down);
    await expect(as.byId({ tradeId: t.id })).rejects.toMatchObject(down);
    await expect(as.prepareResolution({ tradeId: t.id })).rejects.toMatchObject(down);
    await expect(as.recordResolution({ tradeId: t.id, txHash: BUYER_EXIT.landed.hash })).rejects.toMatchObject(down);
    await expect(as.me()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "Couldn't confirm the signer list. Try again." });
    expect(twCall).not.toHaveBeenCalled();
    expect(await resolutions()).toEqual([]);
  });
});

describe("arbiter.list and arbiter.byId", () => {
  it("list: open disputes only, by promise deadline, with yes/no answers and the rule's outcome; never the chat or the notes", async () => {
    // The seller exit's dispute is newer than the buyer exit's, so it comes second.
    const later = await disputedTrade(SELLER_EXIT, { seller: false, buyer: true });
    const first = await disputedTrade(BUYER_EXIT, { seller: true });
    // Not listed: a funded trade with no dispute, an ended one, and a claimable trade's flag.
    await disputedTrade(BUYER_EXIT, {}, { disputed: false, disputeTx: null, disputedAt: null, disputeRecordedAt: null, disputeOpenedBy: null, escrowContractId: "CA".padEnd(56, "A") });
    await disputedTrade(SELLER_EXIT, { seller: false }, { state: "resolved_seller", resolveTx: SELLER_EXIT.landed.hash, escrowContractId: "CB".padEnd(56, "B") });
    await disputedTrade(BUYER_EXIT, {}, CLAIMABLE_FLAGGED);
    // Ömer prepared the buyer exit's resolution (not ready then: it is stored here as prepared).
    const [{ id: resolutionId }] = await f.db
      .insert(arbiterResolutions)
      .values({
        tradeId: first.id,
        outcome: "buyer",
        rule: 1,
        recipient: BUYER_EXIT.escrow.buyer,
        amount: "5",
        unsignedXdr: BUYER_EXIT.rebuilt.unsignedXdr,
        txHash: BUYER_EXIT.rebuilt.txHash,
        signedXdr: BUYER_EXIT.rebuilt.unsignedXdr,
        preparedBy: OMER,
        expiresAt: new Date(BUYER_EXIT.rebuilt.maxTime * 1000),
      })
      .returning();
    // Three days after the buyer exit's dispute: its 72 hours have passed; the seller exit's have not.
    vi.setSystemTime(Date.parse("2026-11-27T10:00:00Z"));

    const list = await f.as(ENSAR).arbiter.list();
    expect(list.map((d) => d.tradeId)).toEqual([first.id, later.id]);
    expect(list[0]).toEqual({
      tradeId: first.id,
      amount: "5.0000000",
      seller: BUYER_EXIT.escrow.seller,
      buyer: BUYER_EXIT.escrow.buyer,
      contractId: BUYER_EXIT.escrow.contractId,
      disputedAt: new Date("2026-11-24T09:56:07Z"),
      disputeRecordedAt: new Date("2026-11-24T09:56:08Z"),
      disputeOpenedBy: "buyer",
      answerDeadline: new Date("2026-11-25T09:56:08Z"),
      promiseDeadline: new Date("2026-11-27T09:56:07Z"),
      overdue: true,
      // The buyer never answered; the window has closed, so the seller's yes decides it.
      answers: { seller: true, buyer: null },
      ready: true,
      outcome: "buyer",
      rule: 1,
      resolution: { id: resolutionId, signers: [], threshold: 2, expiresAt: new Date(BUYER_EXIT.rebuilt.maxTime * 1000) },
    });
    expect(list[1]).toMatchObject({ overdue: false, answers: { seller: false, buyer: true }, ready: true, outcome: "seller", rule: 3, resolution: null });

    const sent = JSON.stringify(list);
    expect(sent).not.toMatch(/CHAT|NOTE/);
    expect(list.flatMap((d) => Object.keys(d))).not.toEqual(expect.arrayContaining([expect.stringMatching(/chat|note|message/i)]));
  });

  it("list: an open window with one answer is not ready and shows no outcome", async () => {
    await disputedTrade(SELLER_EXIT, { buyer: true });
    vi.setSystemTime(Date.parse("2026-11-24T12:00:00Z"));
    expect((await f.as(OMER).arbiter.list())[0]).toMatchObject({ answers: { seller: null, buyer: true }, ready: false, outcome: null, rule: null });
  });

  it("byId: the escrow read fresh, every on-chain step with its link, both notes and the rule's sentence; still no chat", async () => {
    const t = await disputedTrade(SELLER_EXIT, { seller: false, buyer: true });
    chainHas(SELLER_EXIT);
    vi.setSystemTime(Date.parse("2026-11-24T11:00:00Z"));
    const out = await f.as(OMER).arbiter.byId({ tradeId: t.id });
    const e = WP15.exits.seller;
    expect(out).toMatchObject({
      tradeId: t.id,
      state: "funded",
      outcome: "seller",
      rule: 3,
      ruleSentence: "In every other case the seller gets the USDC back.",
      notes: { seller: "NOTE by the seller", buyer: "NOTE by the buyer" },
      feeAddress: TW_FEE_ADDRESS,
      viewerUrl: `https://viewer.trustlesswork.com/testnet/v2/${e.contractId}`,
      escrow: { status: OPEN_DISPUTE, terms: { disputeResolvers: [ARBITER_ACCOUNT], receiver: e.accounts.buyer } },
      steps: (["deploy", "fund", "dispute"] as const).map((s) => ({
        step: s === "deploy" ? "create" : s,
        txHash: e.steps[s].hash,
        url: `https://stellar.expert/explorer/testnet/tx/${e.steps[s].hash}`,
      })),
    });
    expect(readEscrow).toHaveBeenCalledWith(e.contractId);
    expect(JSON.stringify(out, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v))).not.toMatch(/CHAT/);
  });

  it("byId: a trade with no dispute, or a claimable one, is not the arbiter's", async () => {
    const quiet = await disputedTrade(BUYER_EXIT, {}, { disputed: false, disputeTx: null, disputedAt: null, disputeRecordedAt: null, disputeOpenedBy: null });
    const claimable = await disputedTrade(SELLER_EXIT, {}, CLAIMABLE_FLAGGED);
    for (const tradeId of [quiet.id, claimable.id, "00000000-0000-4000-8000-000000000000"]) {
      await expect(f.as(OMER).arbiter.byId({ tradeId })).rejects.toMatchObject({ code: "NOT_FOUND", message: "No dispute for the arbiter on this trade." });
    }
  });
});

describe("arbiter.prepareResolution", () => {
  it("prepares exactly the rule's resolution: Trustless Work's resolve, checked, re-timed to Horizon time + 60 minutes and checked again (HD-3 buyer exit)", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const out = await prepared(BUYER_EXIT, t);

    // Only Pairy's own data goes to Trustless Work: the escrow, the arbiter, the rule's payee and the escrow's balance.
    expect(twCall).toHaveBeenCalledTimes(1);
    expect(twCall).toHaveBeenCalledWith("resolve", BUYER_EXIT.request.body, { tradeId: t.id });
    expect(networkDeadline).toHaveBeenCalledWith(3600);
    // The re-timed resolve is the very transaction Ömer and Ensar signed in HD-3.
    expect(out).toEqual({
      resolutionId: expect.any(String),
      unsignedXdr: BUYER_EXIT.rebuilt.unsignedXdr,
      txHash: "ce561da57cec08f3b2b249e175b357a991ce7c9604eccb119a6a303bbd52588b",
      summary: "Pay this trade's escrow to GCZ2…UVBZ: 4.985 USDC after Trustless Work's 0.3% fee",
      expiresAt: new Date("2026-11-24T10:56:11Z"),
      threshold: 2,
      signers: [],
    });
    // Stored: only the re-timed transaction, never Trustless Work's own (WP-10 N1).
    expect(await resolutions()).toEqual([
      {
        id: out.resolutionId,
        tradeId: t.id,
        outcome: "buyer",
        rule: 1,
        recipient: BUYER_EXIT.escrow.buyer,
        amount: "5.0000000",
        unsignedXdr: BUYER_EXIT.rebuilt.unsignedXdr,
        txHash: BUYER_EXIT.rebuilt.txHash,
        signedXdr: BUYER_EXIT.rebuilt.unsignedXdr,
        signers: [],
        status: "collecting",
        preparedBy: OMER,
        expiresAt: new Date("2026-11-24T10:56:11Z"),
        submittedTx: null,
        createdAt: new Date(Date.parse(BUYER_EXIT.at) + 500),
      },
    ]);
    expect(BUYER_EXIT.rebuilt.unsignedXdr).not.toBe(BUYER_EXIT.response.body.unsignedXdr);
    // Horizon was asked about the arbiter account only: the signer keys are unfunded (O-7).
    expect(vi.mocked(horizon.loadAccount).mock.calls.every(([id]) => id === ARBITER_ACCOUNT)).toBe(true);
  });

  // Each answer pair, with the exit whose resolve pays that side: the buyer exit paid the buyer, the seller exit the seller.
  it.each([
    ["rule 1: the seller says yes, whatever the buyer says", BUYER_EXIT, { seller: true, buyer: false }, false, 1],
    ["rule 2: the seller never answered and the buyer says yes, once the 24 hours are over", BUYER_EXIT, { buyer: true }, true, 2],
    ["rule 3: the contested case (HD-3's seller exit)", SELLER_EXIT, { seller: false, buyer: true }, false, 3],
    ["rule 3: nobody answered in the 24 hours", SELLER_EXIT, {}, true, 3],
    ["rule 3: the seller never answered and the buyer says no", SELLER_EXIT, { buyer: false }, true, 3],
  ] as const)("gives the rule's outcome and nothing else: %s", async (_, exit, answers, windowClosed, rule) => {
    const recorded = windowClosed ? { disputeRecordedAt: new Date(Date.parse(exit.at) - 25 * 3600_000) } : {};
    const t = await disputedTrade(exit, answers, recorded);
    const out = await prepared(exit, t);
    expect(twCall).toHaveBeenCalledWith("resolve", exit.request.body, { tradeId: t.id });
    expect(out.txHash).toBe(exit.rebuilt.txHash);
    const outcome = exit === BUYER_EXIT ? "buyer" : "seller";
    expect(await resolution(out.resolutionId)).toMatchObject({ outcome, rule, recipient: exit.escrow.recipient });
    expect(exit.escrow.recipient).toBe(chainOf(exit).accounts[outcome]);
  });

  it("is refused before the rule is ready, and for a trade with no open dispute, before Trustless Work is asked", async () => {
    vi.setSystemTime(Date.parse(BUYER_EXIT.at) + 500);
    const oneAnswer = await disputedTrade(BUYER_EXIT, { buyer: true });
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: oneAnswer.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Waiting for the traders' answers until 2026-11-25T09:56:08.000Z.",
    });
    const quiet = await disputedTrade(BUYER_EXIT, {}, { disputed: false, disputeTx: null, disputedAt: null, disputeRecordedAt: null, disputeOpenedBy: null, escrowContractId: "CC".padEnd(56, "C") });
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: quiet.id })).rejects.toMatchObject({ code: "NOT_FOUND", message: "No dispute for the arbiter on this trade." });
    const ended = await disputedTrade(SELLER_EXIT, { seller: false }, { state: "resolved_seller", resolveTx: SELLER_EXIT.landed.hash });
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: ended.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This dispute is already settled." });
    expect(twCall).not.toHaveBeenCalled();
    expect(await resolutions()).toEqual([]);
  });

  it("pays out the escrow's USDC balance, never the trade's stored amount (FIXES X-07)", async () => {
    // The trade says 6 USDC; the escrow holds 5: the resolution pays out the 5 it holds.
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true }, { amount: "6" });
    const out = await prepared(BUYER_EXIT, t);
    expect(twCall).toHaveBeenCalledWith("resolve", BUYER_EXIT.request.body, { tradeId: t.id });
    expect(await resolution(out.resolutionId)).toMatchObject({ amount: "5.0000000" });
    await f.db.update(arbiterResolutions).set({ status: "submitted" });

    // A stroop less in the escrow: Pairy asks for 4.9999999, and Trustless Work's resolve paying 5 is refused.
    atPrepare(BUYER_EXIT);
    chainHas(BUYER_EXIT, { balanceStroops: 49_999_999n });
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: t.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining(`It pays out 5 USDC to ${BUYER_EXIT.escrow.buyer}, not 4.9999999 USDC to ${BUYER_EXIT.escrow.buyer}.`),
    });
    expect(twCall).toHaveBeenLastCalledWith(
      "resolve",
      { ...BUYER_EXIT.request.body, distributions: [{ address: BUYER_EXIT.escrow.buyer, amount: 4.9999999 }] },
      { tradeId: t.id },
    );
    expect((await resolutions()).filter((r) => r.status === "collecting")).toEqual([]);
  });

  it("refuses while the escrow's storage would change its price or be archived inside the signing window (O-17, WP-14 C-2)", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const latestLedger = BUYER_EXIT.escrowTtl.latestLedger;
    const ask = () => f.as(OMER).arbiter.prepareResolution({ tradeId: t.id });
    const refused = (message: string) => expect(ask()).rejects.toMatchObject({ code: "BAD_REQUEST", message });

    // The contract extends the ["Escrow"] entry once fewer than 17,280 ledgers are left: not inside the 60 minutes (720 ledgers + 60).
    chainHas(BUYER_EXIT, {}, { escrowLiveUntil: latestLedger + 17_280 + 100 });
    await refused("The escrow's storage rent falls due in about 9 minutes; prepare after that.");
    chainHas(BUYER_EXIT, {}, { escrowLiveUntil: latestLedger + 17_280 });
    await refused("The escrow's storage rent falls due in about a minute; prepare after that.");
    // The instance, the ["Escrow"] entry or the escrow code archived inside the window.
    chainHas(BUYER_EXIT, {}, { instanceLiveUntil: latestLedger + 500 });
    await refused("The escrow's storage is archived in about 42 minutes, inside the signing window; prepare after that.");
    chainHas(BUYER_EXIT, {}, { escrowLiveUntil: latestLedger + 779 });
    await refused("The escrow's storage is archived in about 65 minutes, inside the signing window; prepare after that.");
    chainHas(BUYER_EXIT, {}, {}, latestLedger + 12);
    await refused("Trustless Work's escrow code is archived in about a minute, inside the signing window; prepare after that.");
    // Fails closed without the entry's TTL (the escrow was read by simulation; WP-15 judge N4).
    chainHas(BUYER_EXIT, {}, { escrowLiveUntil: null });
    await refused("Soroban RPC gave no storage TTL for the escrow, so the rent rule cannot be checked; prepare again later.");
    expect(twCall).not.toHaveBeenCalled();

    // Outside both bands it is prepared: past the rent band, below it (the simulation prices the extension), or already archived (it prices the restore).
    for (const ttl of [{ escrowLiveUntil: latestLedger + 17_280 + 780 }, { escrowLiveUntil: latestLedger + 17_279 }, { instanceLiveUntil: 0, escrowLiveUntil: 0 }]) {
      atPrepare(BUYER_EXIT);
      chainHas(BUYER_EXIT, {}, ttl, 0);
      const out = await ask();
      expect(out.txHash).toBe(BUYER_EXIT.rebuilt.txHash);
      await f.db.update(arbiterResolutions).set({ status: "submitted" }).where(eq(arbiterResolutions.id, out.resolutionId));
    }
  });

  it("refuses when the arbiter account fails O-17's preflight, counting only signers at weight 1 or more", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const ask = () => f.as(OMER).arbiter.prepareResolution({ tradeId: t.id });
    const failing = (problem: string) => ({ code: "PRECONDITION_FAILED", message: `The arbiter account fails its check: ${problem}. Fix it before resolving.` });
    const third = Keypair.random().publicKey();

    arbiter = { ...onHorizon(BUYER_EXIT.arbiter.sequence), thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 } };
    await expect(ask()).rejects.toMatchObject(failing("its thresholds are 1/2/2; one signer alone meets a threshold"));
    arbiter = onHorizon(BUYER_EXIT.arbiter.sequence, [{ key: OMER, weight: 2 }, { key: ENSAR, weight: 1 }]);
    await expect(ask()).rejects.toMatchObject(failing("one signer alone meets a threshold"));
    // Horizon lists a removed signer at weight 0: it does not count.
    arbiter = onHorizon(BUYER_EXIT.arbiter.sequence, [{ key: OMER, weight: 1 }, { key: ENSAR, weight: 0 }, { key: third, weight: 0 }]);
    await expect(ask()).rejects.toMatchObject(failing("it has 1 signer"));
    arbiter = onHorizon(BUYER_EXIT.arbiter.sequence);
    arbiter.signers = arbiter.signers.map((s) => (s.key === ARBITER_ACCOUNT ? { ...s, weight: 1 } : s));
    await expect(ask()).rejects.toMatchObject(failing("its own key has weight 1"));
    expect(twCall).not.toHaveBeenCalled();

    // The real account with a weight-0 leftover passes.
    atPrepare(BUYER_EXIT);
    arbiter = onHorizon(BUYER_EXIT.arbiter.sequence, [{ key: ENSAR, weight: 1 }, { key: OMER, weight: 1 }, { key: third, weight: 0 }]);
    expect((await ask()).txHash).toBe(BUYER_EXIT.rebuilt.txHash);
  });

  it("refuses Trustless Work's resolve when it is not the rule's, and passes Trustless Work's refusals on as sentences", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    // The seller exit's resolve, offered for the buyer exit's trade: another escrow, another payee.
    atPrepare(BUYER_EXIT, SELLER_EXIT.response.body);
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: t.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/^Trustless Work returned a resolution Pairy won't ask the signers to sign: .*It calls contract CBHHSX7Z/),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"evt":"arbiter.refused"'));

    vi.mocked(twCall).mockRejectedValueOnce(
      new TwApiError("resolve", 422, "Trustless Work refused the call.", { code: "ESCROW_NOT_IN_DISPUTE", detail: "The escrow is not in dispute." }),
    );
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: t.id })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    vi.mocked(twCall).mockRejectedValueOnce(new TwApiError("resolve", 0, "Trustless Work isn't answering right now. Nothing was signed; try again in a minute."));
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: t.id })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await resolutions()).toEqual([]);
  });

  it("checks the sequence Trustless Work used against Horizon after it answered (WP-15 judge N5)", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    atPrepare(BUYER_EXIT);
    // Another transaction from the arbiter account landed while Trustless Work was preparing.
    vi.mocked(twCall).mockReset().mockImplementationOnce(async () => {
      arbiter = onHorizon(String(BigInt(BUYER_EXIT.arbiter.sequence) + 1n));
      return BUYER_EXIT.response.body as never;
    });
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: t.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The arbiter account moved on while Trustless Work prepared this resolution; prepare again.",
    });
    expect(await resolutions()).toEqual([]);
  });

  it("re-times only maxTime: a rebuild through cloneFrom, which drops the Soroban data, is refused (O-17)", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    atPrepare(BUYER_EXIT);
    vi.mocked(rebuildMaxTime).mockImplementationOnce((unsignedXdr, maxTime) => {
      const tw = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET) as Transaction;
      const cloned = TransactionBuilder.cloneFrom(tw, { timebounds: { minTime: 0, maxTime } }).build();
      return { unsignedXdr: cloned.toXDR(), txHash: Buffer.from(cloned.hash()).toString("hex") };
    });
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: t.id })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "The re-timed resolution differs from Trustless Work's in more than its expiry. Nothing was stored.",
    });
    expect(await resolutions()).toEqual([]);
  });

  it("holds the re-timed window between 10 minutes and 24 hours on the server too", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const nowS = Math.floor((Date.parse(BUYER_EXIT.at) + 500) / 1000);
    for (const [deadline, problem] of [
      [nowS + 5 * 60, "in less than 10 minutes"],
      [nowS + 25 * 3600, "more than 24 hours ahead"],
    ] as const) {
      atPrepare(BUYER_EXIT);
      vi.mocked(networkDeadline).mockResolvedValueOnce(deadline);
      await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: t.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining(problem) });
    }
    expect(await resolutions()).toEqual([]);
  });

  it("refuses an escrow the chain shows settled or not in dispute, and an unreadable one", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const ask = () => f.as(OMER).arbiter.prepareResolution({ tradeId: t.id });
    chainHas(BUYER_EXIT, { disputed: false, resolved: true, balanceStroops: 0n });
    await expect(ask()).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This escrow is already settled on chain; refresh the trade." });
    chainHas(BUYER_EXIT, { disputed: false });
    await expect(ask()).rejects.toMatchObject({ code: "BAD_REQUEST", message: "The escrow on chain is not in dispute; refresh the trade." });
    vi.mocked(readEscrow).mockRejectedValue(new Error("socket hang up"));
    await expect(ask()).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "Couldn't read the escrow from Stellar testnet; try again in a minute." });
    expect(twCall).not.toHaveBeenCalled();
  });
});

describe("arbiter.prepareResolution: one resolution being signed at a time (FIXES F-03)", () => {
  it("returns the trade's open resolution while it can still land, with the signatures so far", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const first = await prepared(BUYER_EXIT, t);
    vi.setSystemTime(receivedAt(BUYER_EXIT, ENSAR));
    await f.as(ENSAR).arbiter.addSignature({ resolutionId: first.resolutionId, signedXdr: copyBy(BUYER_EXIT, ENSAR).envelopeXdr });

    expect(await f.as(OMER).arbiter.prepareResolution({ tradeId: t.id })).toEqual({ ...first, signers: [ENSAR] });
    expect(twCall).toHaveBeenCalledTimes(1);
  });

  it("refuses a second trade while another trade's resolution is being signed", async () => {
    const a = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const b = await disputedTrade(SELLER_EXIT, { seller: false, buyer: true });
    await prepared(BUYER_EXIT, a);
    await expect(f.as(ENSAR).arbiter.prepareResolution({ tradeId: b.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: `Another resolution is being signed (trade ${a.id.slice(0, 8)}). Finish or let it expire first.`,
    });
    expect(twCall).toHaveBeenCalledTimes(1);
  });

  it("lets the second trade go once the first can no longer land: the buyer exit's resolve used the arbiter's sequence", async () => {
    const a = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const b = await disputedTrade(SELLER_EXIT, { seller: false, buyer: true });
    const first = await prepared(BUYER_EXIT, a);
    await signedByBoth(BUYER_EXIT, first.resolutionId);
    // HD-3, 11:27: the buyer exit's resolve has landed (never recorded here), and the arbiter is one sequence on.
    const second = await prepared(SELLER_EXIT, b);
    expect(second.txHash).toBe(SELLER_EXIT.rebuilt.txHash);
    expect((await resolutions()).map((r) => [r.tradeId, r.status])).toEqual([
      [a.id, "expired"],
      [b.id, "collecting"],
    ]);
  });

  it("replaces an expired resolution: by its maxTime, or with none stored, 10 minutes after it was made (F-11)", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const old = await f.db
      .insert(arbiterResolutions)
      .values([
        { tradeId: t.id, outcome: "buyer", rule: 1, recipient: BUYER_EXIT.escrow.buyer, amount: "5", unsignedXdr: BUYER_EXIT.rebuilt.unsignedXdr, txHash: BUYER_EXIT.rebuilt.txHash, signedXdr: BUYER_EXIT.rebuilt.unsignedXdr, preparedBy: OMER, status: "expired" },
      ])
      .returning();
    for (const stale of [
      { expiresAt: new Date(Date.parse(BUYER_EXIT.at)) },
      { expiresAt: null, createdAt: new Date(Date.parse(BUYER_EXIT.at) - 10 * 60_000) },
    ]) {
      const [open] = await f.db
        .insert(arbiterResolutions)
        .values({ ...old[0], id: undefined, status: "collecting", ...stale })
        .returning();
      const out = await prepared(BUYER_EXIT, t);
      expect(out.resolutionId).not.toBe(open.id);
      expect(await resolution(open.id)).toMatchObject({ status: "expired" });
      await f.db.update(arbiterResolutions).set({ status: "submitted" }).where(eq(arbiterResolutions.id, out.resolutionId));
    }
  });

  it("a stale sequence: the row is marked expired and the trade's resolution prepared again", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const first = await prepared(BUYER_EXIT, t);
    // The arbiter account used its next sequence for something else: the prepared resolve can never land.
    vi.setSystemTime(Date.parse(BUYER_EXIT.at) + 60_000);
    const moved = BigInt(BUYER_EXIT.arbiter.sequence) + 1n;
    arbiter = onHorizon(String(moved));
    vi.mocked(twCall).mockResolvedValueOnce(onSequence(BUYER_EXIT.response.body, moved + 1n) as never);
    const again = await f.as(OMER).arbiter.prepareResolution({ tradeId: t.id });

    expect(again.resolutionId).not.toBe(first.resolutionId);
    expect(again.txHash).not.toBe(first.txHash);
    expect(await resolution(first.resolutionId)).toMatchObject({ status: "expired" });
    expect(await resolution(again.resolutionId)).toMatchObject({ status: "collecting" });
  });

  it("a fully signed resolution that is not on chain is marked failed, and prepared again", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const first = await prepared(BUYER_EXIT, t);
    await signedByBoth(BUYER_EXIT, first.resolutionId);
    // Nobody sent it (or the network refused it before any ledger): the arbiter's sequence did not move,
    // and Horizon has no resolve by the arbiter.
    opsByAccount[ARBITER_ACCOUNT] = opsByAccount[ARBITER_ACCOUNT].filter((op) => op.transaction_hash !== BUYER_EXIT.landed.hash);
    const when = Date.parse("2026-11-24T10:30:00Z");
    twAgain(BUYER_EXIT, when);
    const again = await f.as(ENSAR).arbiter.prepareResolution({ tradeId: t.id });

    expect(await resolution(first.resolutionId)).toMatchObject({ status: "failed" });
    expect(again).toMatchObject({ signers: [], expiresAt: new Date(when + 3_600_000) });
    expect(again.txHash).not.toBe(first.txHash);
    expect(await resolution(again.resolutionId)).toMatchObject({ status: "collecting", preparedBy: ENSAR });
  });

  it("a fully signed resolution that did land is never marked failed; the trade is then recorded from it", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const first = await prepared(BUYER_EXIT, t);
    await signedByBoth(BUYER_EXIT, first.resolutionId);
    vi.setSystemTime(Date.parse("2026-11-24T10:27:30Z"));
    // Horizon already lists the arbiter's resolve, though its account record still shows the old sequence.
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: t.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This resolution is on Stellar testnet already; refresh the trade to record it.",
    });
    expect(await resolution(first.resolutionId)).toMatchObject({ status: "collecting" });
    // Once the account shows the used sequence, the row can no longer land, and the escrow reads resolved.
    arbiter = onHorizon(String(BigInt(BUYER_EXIT.arbiter.sequence) + 1n));
    chainHas(BUYER_EXIT, { disputed: false, resolved: true, balanceStroops: 0n });
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: t.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This escrow is already settled on chain; refresh the trade.",
    });
    expect(await resolution(first.resolutionId)).toMatchObject({ status: "expired" });
    expect(twCall).toHaveBeenCalledTimes(1);
    // Recording finds the resolution by its hash, whatever became of the row.
    expect(await f.as(OMER).arbiter.recordResolution({ tradeId: t.id, txHash: BUYER_EXIT.landed.hash })).toMatchObject({ state: "resolved_buyer" });
    expect(await resolution(first.resolutionId)).toMatchObject({ status: "submitted", submittedTx: BUYER_EXIT.landed.hash });
  });

  it("two prepares racing for the one open slot: the one that stores second gets CONFLICT", async () => {
    const a = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const b = await disputedTrade(SELLER_EXIT, { seller: false, buyer: true });
    atPrepare(BUYER_EXIT);
    vi.mocked(twCall).mockReset().mockImplementationOnce(async () => {
      // Trade b's resolution is stored while Trustless Work answers for trade a.
      await f.db.insert(arbiterResolutions).values({
        tradeId: b.id,
        outcome: "seller",
        rule: 3,
        recipient: SELLER_EXIT.escrow.seller,
        amount: "5",
        unsignedXdr: SELLER_EXIT.rebuilt.unsignedXdr,
        txHash: SELLER_EXIT.rebuilt.txHash,
        signedXdr: SELLER_EXIT.rebuilt.unsignedXdr,
        preparedBy: ENSAR,
        expiresAt: new Date(SELLER_EXIT.rebuilt.maxTime * 1000),
      });
      return BUYER_EXIT.response.body as never;
    });
    await expect(f.as(OMER).arbiter.prepareResolution({ tradeId: a.id })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Another resolution was prepared at the same moment. Reload the page.",
    });
    expect((await resolutions()).map((r) => r.tradeId)).toEqual([b.id]);
  });
});

describe("arbiter.addSignature", () => {
  it.each(["buyer", "seller"] as const)(
    "collects the two signatures one by one and merges them into the envelope that landed (HD-3 %s exit)",
    async (side) => {
      const exit = EXIT[side];
      const t = await disputedTrade(exit, side === "buyer" ? { seller: true, buyer: true } : { seller: false, buyer: true });
      const { resolutionId } = await prepared(exit, t);
      const [firstSigner, secondSigner] = exit.signatures.map((s) => s.signer);

      vi.setSystemTime(receivedAt(exit, firstSigner));
      const one = await f.as(firstSigner).arbiter.addSignature({ resolutionId, signedXdr: copyBy(exit, firstSigner).envelopeXdr });
      expect(one).toEqual({ signedXdr: copyBy(exit, firstSigner).envelopeXdr, signerCount: 1, threshold: 2, signers: [firstSigner] });
      // One signature is not enough: testnet refused exactly this envelope before any ledger (WP-15 judge N7: the decoded result).
      expect(xdr.TransactionResult.fromXDR(copyBy(exit, firstSigner).resultXdr, "base64").result.type).toBe("txBadAuth");

      vi.setSystemTime(receivedAt(exit, secondSigner));
      const two = await f.as(secondSigner).arbiter.addSignature({ resolutionId, signedXdr: copyBy(exit, secondSigner).envelopeXdr });
      // Byte for byte the envelope Horizon took.
      expect(two).toEqual({ signedXdr: exit.landed.signedXdr, signerCount: 2, threshold: 2, signers: [firstSigner, secondSigner] });
      expect(await resolution(resolutionId)).toMatchObject({ status: "collecting", signedXdr: exit.landed.signedXdr, signers: [firstSigner, secondSigner] });
    },
  );

  it("refuses a signature by any key that is not the arbiter's signer, and a copy of another transaction", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const { resolutionId } = await prepared(BUYER_EXIT, t);
    const foreign = Keypair.random();
    const signedBy = (base: string, ...keys: Keypair[]) => {
      const tx = TransactionBuilder.fromXDR(base, Networks.TESTNET);
      for (const k of keys) tx.sign(k);
      return tx.toXDR();
    };
    const add = (signedXdr: string) => f.as(ENSAR).arbiter.addSignature({ resolutionId, signedXdr });

    await expect(add(signedBy(BUYER_EXIT.rebuilt.unsignedXdr, foreign))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "A signature on this transaction is not from one of the arbiter's signers.",
    });
    // Ensar's real signature, with a stranger's next to it.
    await expect(add(signedBy(copyBy(BUYER_EXIT, ENSAR).envelopeXdr, foreign))).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Ensar's real signature on the seller exit's resolve, and WP-15's test-arbiter resolve: other transactions.
    for (const other of [copyBy(SELLER_EXIT, ENSAR).envelopeXdr, TEST_RUN.landed.signedXdr]) {
      await expect(add(other)).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "This was signed on a different transaction from the one prepared. Prepare it again and sign that one.",
      });
    }
    // Trustless Work's own resolve, before Pairy re-timed it, is another transaction too (O-17: signatures are checked against the re-timed hash).
    await expect(add(BUYER_EXIT.response.body.unsignedXdr)).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("different transaction") });
    await expect(add("not a transaction")).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await resolution(resolutionId)).toMatchObject({ signers: [], signedXdr: BUYER_EXIT.rebuilt.unsignedXdr });
  });

  it("adds only the caller's own signature, once, and none past the threshold", async () => {
    const third = Keypair.random();
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const { resolutionId } = await prepared(BUYER_EXIT, t);
    vi.setSystemTime(receivedAt(BUYER_EXIT, ENSAR));

    // Ömer posting Ensar's copy: it carries no signature by Ömer.
    await expect(f.as(OMER).arbiter.addSignature({ resolutionId, signedXdr: copyBy(BUYER_EXIT, ENSAR).envelopeXdr })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This copy carries no signature by your key. Sign it with the signer key you signed in with.",
    });
    await f.as(ENSAR).arbiter.addSignature({ resolutionId, signedXdr: copyBy(BUYER_EXIT, ENSAR).envelopeXdr });
    await expect(f.as(ENSAR).arbiter.addSignature({ resolutionId, signedXdr: copyBy(BUYER_EXIT, ENSAR).envelopeXdr })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "You already signed this resolution.",
    });
    await f.as(OMER).arbiter.addSignature({ resolutionId, signedXdr: copyBy(BUYER_EXIT, OMER).envelopeXdr });

    // A third signer (a 2-of-3 account): a signature past the threshold would make the network refuse it (tx_bad_auth_extra).
    arbiter = onHorizon(BUYER_EXIT.arbiter.sequence, [ENSAR, OMER, third.publicKey()].map((key) => ({ key, weight: 1 })));
    await arbiterAccountNow();
    const tx = TransactionBuilder.fromXDR(BUYER_EXIT.rebuilt.unsignedXdr, Networks.TESTNET);
    tx.sign(third);
    await expect(f.as(third.publicKey()).arbiter.addSignature({ resolutionId, signedXdr: tx.toXDR() })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This resolution already has the signatures it needs.",
    });
    expect(await resolution(resolutionId)).toMatchObject({ signedXdr: BUYER_EXIT.landed.signedXdr, signers: [ENSAR, OMER] });
  });

  it("refuses a stale resolution and marks it expired: the arbiter account moved on, or the window closed", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const { resolutionId } = await prepared(BUYER_EXIT, t);
    vi.setSystemTime(receivedAt(BUYER_EXIT, ENSAR));
    arbiter = onHorizon(String(BigInt(BUYER_EXIT.arbiter.sequence) + 1n));
    await expect(f.as(ENSAR).arbiter.addSignature({ resolutionId, signedXdr: copyBy(BUYER_EXIT, ENSAR).envelopeXdr })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "The arbiter account moved on; prepare again.",
    });
    expect(await resolution(resolutionId)).toMatchObject({ status: "expired", signers: [] });

    await f.db.update(arbiterResolutions).set({ status: "submitted" });
    const again = await prepared(BUYER_EXIT, t);
    vi.setSystemTime(BUYER_EXIT.rebuilt.maxTime * 1000);
    await expect(f.as(ENSAR).arbiter.addSignature({ resolutionId: again.resolutionId, signedXdr: copyBy(BUYER_EXIT, ENSAR).envelopeXdr })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This prepared transaction expired at 2026-11-24T10:56:11.000Z. Prepare again.",
    });
    expect(await resolution(again.resolutionId)).toMatchObject({ status: "expired" });
  });

  it("refuses a resolution that is no longer collecting, and one that does not exist", async () => {
    const t = await disputedTrade(BUYER_EXIT, { seller: true, buyer: true });
    const { resolutionId } = await prepared(BUYER_EXIT, t);
    const add = () => f.as(ENSAR).arbiter.addSignature({ resolutionId, signedXdr: copyBy(BUYER_EXIT, ENSAR).envelopeXdr });
    for (const [status, message] of [
      ["expired", "This prepared transaction expired. Prepare again."],
      ["failed", "This prepared transaction was not accepted by the network; prepare again."],
      ["submitted", "This resolution was already sent."],
    ] as const) {
      await f.db.update(arbiterResolutions).set({ status }).where(eq(arbiterResolutions.id, resolutionId));
      await expect(add()).rejects.toMatchObject({ code: "BAD_REQUEST", message });
    }
    await expect(
      f.as(ENSAR).arbiter.addSignature({ resolutionId: "00000000-0000-4000-8000-000000000000", signedXdr: copyBy(BUYER_EXIT, ENSAR).envelopeXdr }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("arbiter.recordResolution", () => {
  /** A trade whose resolution both signers signed, and whose resolve has landed (HD-3). */
  async function signedAndLanded(exit: Resolve, answers: Answers) {
    const t = await disputedTrade(exit, answers);
    const { resolutionId } = await prepared(exit, t);
    await signedByBoth(exit, resolutionId);
    vi.setSystemTime(Date.parse(chainOf(exit).steps.resolve.transaction.created_at) + 5_000);
    return { t, resolutionId };
  }
  const notes = (tradeId: string) => f.db.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, tradeId)).orderBy(disputeAnswers.role);
  const chat = (tradeId: string) => f.db.select().from(chatMessages).where(eq(chatMessages.tradeId, tradeId));
  const remaining = async (listingId: string) => (await f.db.select().from(listings).where(eq(listings.id, listingId)))[0].remainingAmount;

  it("records the buyer exit's landed resolve, read back from Horizon: resolved_buyer, chat and notes gone, answers kept", async () => {
    const { t, resolutionId } = await signedAndLanded(BUYER_EXIT, { seller: true, buyer: true });
    const out = await f.as(OMER).arbiter.recordResolution({ tradeId: t.id, txHash: BUYER_EXIT.landed.hash.toUpperCase() });

    expect(out).toMatchObject({ state: "resolved_buyer", resolveTx: BUYER_EXIT.landed.hash, resolvedAt: new Date("2026-11-24T10:26:57Z") });
    expect(await chat(t.id)).toEqual([]);
    expect((await notes(t.id)).map((a) => [a.role, a.cashHandedOver, a.note])).toEqual([
      ["seller", true, null],
      ["buyer", true, null],
    ]);
    expect(await resolution(resolutionId)).toMatchObject({ status: "submitted", submittedTx: BUYER_EXIT.landed.hash });
    // The buyer was paid: the 5 USDC stay used up on the listing.
    expect(await remaining(t.listingId)).toBe("95.0000000");
  });

  it("records the seller exit's: resolved_seller, and the listing's remaining amount is given back in full", async () => {
    const { t, resolutionId } = await signedAndLanded(SELLER_EXIT, { seller: false, buyer: true });
    const out = await f.as(ENSAR).arbiter.recordResolution({ tradeId: t.id, txHash: SELLER_EXIT.landed.hash });

    expect(out).toMatchObject({ state: "resolved_seller", resolveTx: SELLER_EXIT.landed.hash, resolvedAt: new Date("2026-11-24T11:32:52Z") });
    expect(await chat(t.id)).toEqual([]);
    expect((await notes(t.id)).every((a) => a.note === null)).toBe(true);
    expect(await resolution(resolutionId)).toMatchObject({ status: "submitted", submittedTx: SELLER_EXIT.landed.hash });
    expect(await remaining(t.listingId)).toBe("100.0000000");
  });

  it("is done when the trade already shows this resolve, whether recorded here or by the sync first", async () => {
    const { t, resolutionId } = await signedAndLanded(BUYER_EXIT, { seller: true, buyer: true });
    // The trade room's sync found the resolve first.
    await transitionTrade(f.db, t.id, { type: "resolve", by: "arbiter", outcome: "buyer", txHash: BUYER_EXIT.landed.hash, resolvedAt: new Date("2026-11-24T10:26:57Z") });
    const out = await f.as(OMER).arbiter.recordResolution({ tradeId: t.id, txHash: BUYER_EXIT.landed.hash });
    expect(out).toMatchObject({ state: "resolved_buyer", resolveTx: BUYER_EXIT.landed.hash });
    expect(await resolution(resolutionId)).toMatchObject({ status: "submitted", submittedTx: BUYER_EXIT.landed.hash });
    expect(await f.as(OMER).arbiter.recordResolution({ tradeId: t.id, txHash: BUYER_EXIT.landed.hash })).toMatchObject({ state: "resolved_buyer" });
  });

  it("refuses a transaction that is not this trade's prepared resolution, or that paid out other than prepared", async () => {
    const { t, resolutionId } = await signedAndLanded(BUYER_EXIT, { seller: true, buyer: true });
    const record = (txHash: string) => f.as(OMER).arbiter.recordResolution({ tradeId: t.id, txHash });

    // The seller exit's resolve, and the trade's own dispute: not a resolution prepared for this trade.
    for (const hash of [SELLER_EXIT.landed.hash, chainOf(BUYER_EXIT).steps.dispute.hash]) {
      await expect(record(hash)).rejects.toMatchObject({ code: "BAD_REQUEST", message: "This transaction is not a resolution prepared for this trade." });
    }
    // The prepared row says the seller, but the resolve on chain paid the buyer.
    await f.db.update(arbiterResolutions).set({ recipient: BUYER_EXIT.escrow.seller }).where(eq(arbiterResolutions.id, resolutionId));
    await expect(record(BUYER_EXIT.landed.hash)).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: `The resolve on chain paid 5 USDC to ${BUYER_EXIT.escrow.buyer}, not the prepared 5 USDC to ${BUYER_EXIT.escrow.seller}.`,
    });
    // Not landed yet, and Horizon down.
    await f.db.update(arbiterResolutions).set({ recipient: BUYER_EXIT.escrow.buyer }).where(eq(arbiterResolutions.id, resolutionId));
    delete txs[BUYER_EXIT.landed.hash];
    await expect(record(BUYER_EXIT.landed.hash)).rejects.toMatchObject({ code: "BAD_REQUEST", message: `Transaction ${BUYER_EXIT.landed.hash} was not found on Stellar testnet.` });
    expect(await row(t.id)).toMatchObject({ state: "funded", resolveTx: null });
    expect(await chat(t.id)).toHaveLength(1);
  });
});
