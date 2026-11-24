// The escrow router (D2 §5.2, part 1) on pglite. Trustless Work, Horizon and
// Soroban RPC are mocked; validateEscrowCall is not. Trustless Work's answers
// are the ones it gave for Gate D2 (tests/fixtures/tw/gate-d2-*.json), and the
// trade has Gate D2's parties and amount, so the server's own XDR check runs
// on real transactions. The clock is set inside each transaction's 5-minute
// validity.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Keypair, type Horizon } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatMessages, disputeAnswers, listings, trades, users } from "@/lib/db/schema";
import { createTestDb } from "@/lib/db/test-setup";
import { ACCEPTANCE_ITEMS, ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import {
  ARBITER_ACCOUNT,
  PLATFORM_ACCOUNT,
  PROTECTED_WALLET_KINDS,
  TW_ESCROW_WASM_HASH,
  TW_FEE_ADDRESS,
  TW_VIEWER_BASE,
  USDC_SAC,
} from "@/lib/escrow/config";
import { EscrowNotFoundError, readEscrow, readWasmHash } from "@/lib/escrow/read";
import { expectedTerms } from "@/lib/escrow/terms";
import { EscrowMismatchError, findEscrowTx, verifyEscrowTx } from "@/lib/escrow/verify";
import { TESTNET_USDC_ISSUER } from "@/lib/stellar/assets";
import { loadAccount } from "@/lib/stellar/horizon";
import { transitionTrade } from "@/lib/trade/persist";
import { callerFor } from "@/lib/trade/test-helpers";
import { arbiterAccountState, isArbiterSigner } from "@/server/api/arbiter-auth";
import { TwApiError, twCall, twConfigured } from "@/server/tw/client";

vi.mock("@/server/tw/client", async (orig) => ({
  ...(await orig<typeof import("@/server/tw/client")>()),
  twCall: vi.fn(),
  twConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/escrow/verify", async (orig) => ({
  ...(await orig<typeof import("@/lib/escrow/verify")>()),
  verifyEscrowTx: vi.fn(),
  findEscrowTx: vi.fn(async () => null),
}));
vi.mock("@/lib/escrow/read", async (orig) => ({
  ...(await orig<typeof import("@/lib/escrow/read")>()),
  readEscrow: vi.fn(),
  readWasmHash: vi.fn(),
}));
vi.mock("@/lib/stellar/horizon", async (orig) => ({
  ...(await orig<typeof import("@/lib/stellar/horizon")>()),
  loadAccount: vi.fn(),
}));
vi.mock("@/server/api/arbiter-auth", async (orig) => ({
  ...(await orig<typeof import("@/server/api/arbiter-auth")>()),
  arbiterAccountState: vi.fn(),
  isArbiterSigner: vi.fn(async () => false),
}));

// Gate D2's trade (scripts/evidence/out/escrow-release-real.json).
const SELLER = "GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y";
const BUYER = "GB2HNRJNZDLD2FRPS4SKS5Y4HB65IUDI6QSVPID7ZADMLBBQ255TZOYQ";
const ADMIN = "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5";
const ESCROW = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const OTHER_ESCROW = "CCGML7GRKDX42ZYSSXSQYXU7Q5HQ3A6O2SZZPLOYVJY6CROAJHVRYAUN";
const OMER = "GDRJ7JMJPBAGHKLP5JZJ6S6CP3OZ2ZURM23RBHR2N56MDOFSOOLQLD5Q";
const ENSAR = "GDH2MGKJYMEZEHR62RRFYGHHK74AQ2AFZKUEP6GWCK5BRFB2A3T2N6J7";

type Prepared = { at: string; response: { body: { unsignedXdr: string; txHash: string; contractId?: string } } };
const tw = (name: string): Prepared => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw", `${name}.json`), "utf8"));
const DEPLOY = tw("gate-d2-deploy");
const FUND = tw("gate-d2-fund");
const RELEASE = tw("gate-d2-release");
/** A moment inside the prepared transaction's validity. */
const during = (p: Prepared, seconds = 1) => new Date(Date.parse(p.at) + seconds * 1000);
const HASH = { deploy: DEPLOY.response.body.txHash, fund: FUND.response.body.txHash, release: RELEASE.response.body.txHash };

const terms = expectedTerms({ buyer: BUYER, seller: SELLER, amount: "5", escrowAdmin: ADMIN });

type RpcCall = { request: { method: string; params: unknown }; response: unknown };
const rpcRecording = (name: string): { contractId: string; calls: RpcCall[] } =>
  JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/soroban-rpc", `${name}.json`), "utf8"));

/**
 * The real readEscrow, answered by Soroban RPC as recorded on testnet: fetch
 * replays the recorded getLedgerEntries answer and nothing else.
 */
async function chainRecorded(name: string) {
  const { calls } = rpcRecording(name);
  const actual = await vi.importActual<typeof import("@/lib/escrow/read")>("@/lib/escrow/read");
  vi.mocked(readEscrow).mockImplementation(actual.readEscrow);
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

function account(o: { xlm: string; usdc?: string; signers?: { key: string; weight: number }[] }): Horizon.AccountResponse {
  const balances: object[] = [{ asset_type: "native", balance: o.xlm, selling_liabilities: "0.0000000" }];
  if (o.usdc !== undefined) {
    balances.push({
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: TESTNET_USDC_ISSUER,
      balance: o.usdc,
      limit: "922337203685.4775807",
      is_authorized: true,
      selling_liabilities: "0.0000000",
      buying_liabilities: "0.0000000",
    });
  }
  return { balances, subentry_count: o.usdc === undefined ? 0 : 1, num_sponsoring: 0, num_sponsored: 0, signers: o.signers ?? [] } as never;
}

let accounts: Record<string, Horizon.AccountResponse | null>;
let log: ReturnType<typeof vi.spyOn>;

/** What Soroban RPC shows for an escrow; null = no contract there. */
function chainHas(escrow: { balance?: bigint; terms?: typeof terms } | null) {
  vi.mocked(readEscrow).mockImplementation(async (id) => {
    if (!escrow) throw new EscrowNotFoundError(id);
    return {
      terms: escrow.terms ?? terms,
      status: { disputed: false, released: false, resolved: false, balanceStroops: escrow.balance ?? 0n },
      ttl: { latestLedger: 5_897_050, instanceLiveUntil: 6_018_006, escrowLiveUntil: 6_018_006 },
    };
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(during(DEPLOY, -60));
  vi.stubEnv("PROTECTED_MODE", "on");
  accounts = {
    [SELLER]: account({ xlm: "100", usdc: "10" }),
    [BUYER]: account({ xlm: "10", usdc: "0" }),
    [ADMIN]: account({ xlm: "10000" }),
    [PLATFORM_ACCOUNT]: account({ xlm: "10", usdc: "0", signers: [{ key: PLATFORM_ACCOUNT, weight: 0 }] }),
  };
  vi.mocked(loadAccount).mockReset().mockImplementation(async (key) => accounts[key] ?? null);
  vi.mocked(arbiterAccountState).mockReset().mockResolvedValue({
    masterWeight: 0,
    thresholds: { low: 2, med: 2, high: 2 },
    signers: [
      { key: OMER, weight: 1 },
      { key: ENSAR, weight: 1 },
    ],
  });
  vi.mocked(isArbiterSigner).mockReset().mockResolvedValue(false);
  vi.mocked(twConfigured).mockReset().mockReturnValue(true);
  vi.mocked(twCall).mockReset().mockImplementation(async (ep) => {
    throw new Error(`unexpected Trustless Work call: ${ep}`);
  });
  vi.mocked(verifyEscrowTx).mockReset();
  vi.mocked(findEscrowTx).mockReset().mockResolvedValue(null);
  vi.mocked(readWasmHash).mockReset().mockResolvedValue(TW_ESCROW_WASM_HASH!);
  chainHas(null);
  log = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture() {
  const { db } = await createTestDb();
  const stranger = Keypair.random().publicKey();
  await db.insert(users).values([SELLER, BUYER, stranger].map((publicKey) => ({ publicKey })));
  const [listing] = await db
    .insert(listings)
    .values({
      owner: SELLER,
      side: "sell_crypto",
      asset: "USDC",
      minAmount: "1",
      maxAmount: "100",
      remainingAmount: "100",
      fiatCode: "TRY",
      rate: "41.0000",
      cityId: "745044",
      cityName: "Istanbul",
      countryCode: "TR",
      latitude: "41.01384",
      longitude: "28.94966",
    })
    .returning();
  return { db, listing, stranger, as: (pk: string | null) => callerFor(db, pk) };
}

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});

/** The buyer opens a protected trade for 5 USDC and accepts; the seller agrees and accepts. */
async function agreedTrade() {
  const t = await f.as(BUYER).trade.open({ listingId: f.listing.id, amount: "5", mode: "protected", acceptanceVersion: ACCEPTANCE_VERSION });
  await f.as(SELLER).trade.agree({ tradeId: t.id, acceptanceVersion: ACCEPTANCE_VERSION });
  return t;
}

const prepared = (p: Prepared) => vi.mocked(twCall).mockResolvedValueOnce(p.response.body as never);
const row = async (id: string) => (await f.db.select().from(trades).where(eq(trades.id, id)))[0];
const set = (id: string, values: Partial<typeof trades.$inferInsert>) => f.db.update(trades).set(values).where(eq(trades.id, id));

async function createdTrade() {
  const t = await agreedTrade();
  vi.setSystemTime(during(DEPLOY));
  prepared(DEPLOY);
  await f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN });
  vi.mocked(verifyEscrowTx).mockResolvedValueOnce({ createdAt: new Date("2026-11-24T08:27:57Z"), signer: ADMIN, contractId: ESCROW, transfers: [] });
  chainHas({});
  await f.as(SELLER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy });
  return t;
}

async function fundedTrade() {
  const t = await createdTrade();
  vi.setSystemTime(during(FUND));
  prepared(FUND);
  await f.as(SELLER).escrow.prepareFund({ tradeId: t.id });
  vi.mocked(verifyEscrowTx).mockResolvedValueOnce({
    createdAt: new Date("2026-11-24T08:28:02Z"),
    signer: SELLER,
    contractId: ESCROW,
    transfers: [{ from: SELLER, to: ESCROW, amountStroops: 50_000_000n }],
  });
  await f.as(SELLER).escrow.recordFund({ tradeId: t.id, txHash: HASH.fund });
  return t;
}

const RELEASED = {
  createdAt: new Date("2026-11-24T08:28:07Z"),
  signer: SELLER,
  contractId: ESCROW,
  transfers: [
    { from: ESCROW, to: TW_FEE_ADDRESS!, amountStroops: 150_000n },
    { from: ESCROW, to: BUYER, amountStroops: 49_850_000n },
  ],
};

describe("escrow: the happy path to released", () => {
  it("opens, accepts, creates, funds and releases, asking Trustless Work only with Pairy's own data", async () => {
    const t = await agreedTrade();
    expect(await row(t.id)).toMatchObject({ state: "agreed", mode: "protected", windowSeconds: 0, acceptanceVersion: ACCEPTANCE_VERSION });

    const pre = await f.as(SELLER).escrow.preflight({ tradeId: t.id });
    expect(pre).toMatchObject({ ok: true, blockedReason: null });
    expect(pre.checks.map((c) => c.id)).toEqual([
      "bothAccepted",
      "arbiterAccount",
      "platformAccount",
      "sellerAccount",
      "sellerUsdc",
      "sellerXlm",
      "buyerAccount",
      "buyerTrustline",
    ]);

    // Create: the exact deploy body, built from the trade row and the committed constants (D2 §6).
    vi.setSystemTime(during(DEPLOY));
    prepared(DEPLOY);
    const create = await f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN });
    expect(twCall).toHaveBeenLastCalledWith(
      "deploy",
      {
        signer: ADMIN,
        engagementId: t.id,
        title: `Pairy trade ${t.id.slice(0, 8)}`,
        description: "Pairy protected trade, Stellar testnet",
        roles: {
          approvers: [SELLER],
          serviceProviders: [SELLER],
          releaseSigners: [SELLER],
          receiver: BUYER,
          platform: PLATFORM_ACCOUNT,
          disputeResolvers: [ARBITER_ACCOUNT],
          admin: ADMIN,
        },
        amount: 5,
        platformFee: 0,
        trustline: { contractId: USDC_SAC },
        milestones: [{ description: "Cash handed over" }],
      },
      { tradeId: t.id },
    );
    expect(create).toEqual({
      unsignedXdr: DEPLOY.response.body.unsignedXdr,
      txHash: HASH.deploy,
      contractId: ESCROW,
      summary: "Create this trade's escrow for 5 USDC",
    });
    // F-02: the admin and the escrow's address are stored at prepare, before anything is signed.
    expect(await row(t.id)).toMatchObject({ state: "agreed", escrowAdmin: ADMIN, escrowContractId: ESCROW, escrowPreparedAt: during(DEPLOY) });

    vi.mocked(verifyEscrowTx).mockResolvedValueOnce({ createdAt: new Date("2026-11-24T08:27:57Z"), signer: ADMIN, contractId: ESCROW, transfers: [] });
    chainHas({});
    const created = await f.as(BUYER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy });
    expect(created).toMatchObject({ state: "escrow_created", createTx: HASH.deploy, escrowContractId: ESCROW });
    expect(verifyEscrowTx).toHaveBeenLastCalledWith(HASH.deploy, { kind: "deploy", admin: ADMIN, contractId: ESCROW, terms });
    expect(readEscrow).toHaveBeenLastCalledWith(ESCROW);
    expect(readWasmHash).toHaveBeenLastCalledWith(ESCROW);

    // Fund: preflight now also reads the escrow's terms and finds it empty.
    vi.setSystemTime(during(FUND));
    expect((await f.as(SELLER).escrow.preflight({ tradeId: t.id })).checks.slice(-2)).toMatchObject([
      { id: "escrowTerms", ok: true },
      { id: "escrowEmpty", ok: true },
    ]);
    prepared(FUND);
    const fund = await f.as(SELLER).escrow.prepareFund({ tradeId: t.id });
    expect(twCall).toHaveBeenLastCalledWith("fund", { contractId: ESCROW, signer: SELLER, amount: 5 }, { tradeId: t.id });
    expect(fund).toEqual({ unsignedXdr: FUND.response.body.unsignedXdr, txHash: HASH.fund, summary: "Fund this trade's escrow with 5 USDC" });

    vi.mocked(verifyEscrowTx).mockResolvedValueOnce({
      createdAt: new Date("2026-11-24T08:28:02Z"),
      signer: SELLER,
      contractId: ESCROW,
      transfers: [{ from: SELLER, to: ESCROW, amountStroops: 50_000_000n }],
    });
    const funded = await f.as(SELLER).escrow.recordFund({ tradeId: t.id, txHash: HASH.fund });
    expect(funded).toMatchObject({ state: "funded", fundTx: HASH.fund, fundedAt: new Date("2026-11-24T08:28:02Z") });
    expect(verifyEscrowTx).toHaveBeenLastCalledWith(HASH.fund, { kind: "fund", contractId: ESCROW, seller: SELLER, amountStroops: 50_000_000n, terms });

    await f.as(BUYER).chat.send({ tradeId: t.id, body: "At the cafe." });

    // Release.
    vi.setSystemTime(during(RELEASE, 5));
    prepared(RELEASE);
    vi.mocked(readEscrow).mockClear();
    const release = await f.as(SELLER).escrow.prepareRelease({ tradeId: t.id });
    expect(twCall).toHaveBeenLastCalledWith("approveAndRelease", { contractId: ESCROW, signer: SELLER, milestoneIndexes: [0] }, { tradeId: t.id });
    // O-24: the chain is read before Trustless Work is asked.
    expect(vi.mocked(readEscrow).mock.calls).toEqual([[ESCROW]]);
    expect(vi.mocked(readEscrow).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(twCall).mock.invocationCallOrder.at(-1)!);
    expect(release).toEqual({
      unsignedXdr: RELEASE.response.body.unsignedXdr,
      txHash: HASH.release,
      summary: "Release this trade's escrow to the buyer, less Trustless Work's 0.3% fee",
    });

    vi.mocked(verifyEscrowTx).mockResolvedValueOnce(RELEASED);
    const released = await f.as(BUYER).escrow.recordRelease({ tradeId: t.id, txHash: HASH.release });
    expect(released).toMatchObject({ state: "released", releaseTx: HASH.release });
    expect(verifyEscrowTx).toHaveBeenLastCalledWith(HASH.release, { kind: "release", contractId: ESCROW, seller: SELLER });
    expect(log.mock.calls.flat().join()).not.toMatch(/fee_mismatch/);

    // Terminal: chat purged (D3), the 5 USDC used up on the listing.
    expect(await f.db.select().from(chatMessages).where(eq(chatMessages.tradeId, t.id))).toEqual([]);
    expect((await f.db.select().from(listings).where(eq(listings.id, f.listing.id)))[0].remainingAmount).toBe("95.0000000");

    const room = await f.as(BUYER).trade.byId({ id: t.id });
    expect(room).toMatchObject({ mode: "protected", viewerUrl: `${TW_VIEWER_BASE}/testnet/v2/${ESCROW}`, stallNudge: false });
    expect(room.events.map((e) => [e.type, e.by, e.txHash])).toEqual([
      ["open", "buyer", null],
      ["agree", "seller", null],
      ["escrowCreate", "seller", HASH.deploy],
      ["fund", "seller", HASH.fund],
      ["release", "seller", HASH.release],
    ]);
    // Trustless Work was asked exactly three times, never to submit.
    expect(vi.mocked(twCall).mock.calls.map(([ep]) => ep)).toEqual(["deploy", "fund", "approveAndRelease"]);
  });

  it("treats a repeated record of the same transaction as done, without reading the chain again", async () => {
    const t = await fundedTrade();
    vi.mocked(verifyEscrowTx).mockClear();
    expect(await f.as(SELLER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy })).toMatchObject({ state: "funded" });
    expect(await f.as(BUYER).escrow.recordFund({ tradeId: t.id, txHash: HASH.fund.toUpperCase() })).toMatchObject({ state: "funded" });
    expect(verifyEscrowTx).not.toHaveBeenCalled();
  });
});

describe("escrow.config", () => {
  it("is public and says protected trades are on only with PROTECTED_MODE=on and a Trustless Work key", async () => {
    const config = await f.as(null).escrow.config();
    expect(config).toEqual({
      enabled: true,
      arbiterAccount: ARBITER_ACCOUNT,
      platformAccount: PLATFORM_ACCOUNT,
      usdcContract: USDC_SAC,
      viewerBase: TW_VIEWER_BASE,
      acceptanceVersion: ACCEPTANCE_VERSION,
      acceptanceItems: ACCEPTANCE_ITEMS,
      protectedWalletKinds: PROTECTED_WALLET_KINDS,
    });
    for (const off of ["off", "", "ON", "true"]) {
      vi.stubEnv("PROTECTED_MODE", off);
      expect((await f.as(null).escrow.config()).enabled).toBe(false);
    }
    vi.stubEnv("PROTECTED_MODE", "on");
    vi.mocked(twConfigured).mockReturnValue(false);
    expect((await f.as(null).escrow.config()).enabled).toBe(false);
  });
});

describe("escrow: who may call what", () => {
  it("hides a trade from anyone who is not one of its two traders", async () => {
    const t = await agreedTrade();
    await expect(f.as(f.stranger).escrow.preflight({ tradeId: t.id })).rejects.toThrow(/Trade not found/);
    await expect(f.as(f.stranger).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toThrow(/Trade not found/);
    await expect(f.as(f.stranger).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy })).rejects.toThrow(/Trade not found/);
    await expect(f.as(null).escrow.prepareFund({ tradeId: t.id })).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("refuses every escrow step on a claimable trade", async () => {
    const t = await f.as(BUYER).trade.open({ listingId: f.listing.id, amount: "5" });
    await f.as(SELLER).trade.agree({ tradeId: t.id });
    const notProtected = /not a protected trade/;
    await expect(f.as(SELLER).escrow.preflight({ tradeId: t.id })).rejects.toThrow(notProtected);
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toThrow(notProtected);
    await expect(f.as(SELLER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy })).rejects.toThrow(notProtected);
    await expect(f.as(SELLER).escrow.prepareFund({ tradeId: t.id })).rejects.toThrow(notProtected);
    await expect(f.as(SELLER).escrow.recordFund({ tradeId: t.id, txHash: HASH.fund })).rejects.toThrow(notProtected);
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toThrow(notProtected);
    await expect(f.as(SELLER).escrow.recordRelease({ tradeId: t.id, txHash: HASH.release })).rejects.toThrow(notProtected);
    expect(twCall).not.toHaveBeenCalled();
  });

  it("lets only the seller prepare the create, the fund and the release", async () => {
    const t = await agreedTrade();
    await expect(f.as(BUYER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const c = await createdTrade();
    await expect(f.as(BUYER).escrow.prepareFund({ tradeId: c.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(twCall).toHaveBeenCalledTimes(1); // only the seller's create in createdTrade
  });

  it("refuses a step the trade is not at, before asking Trustless Work (it prepares wrong-state calls anyway)", async () => {
    const opened = await f.as(BUYER).trade.open({ listingId: f.listing.id, amount: "5", mode: "protected", acceptanceVersion: ACCEPTANCE_VERSION });
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: opened.id, admin: ADMIN })).rejects.toThrow(/Only an agreed trade gets an escrow/);
    const t = await agreedTrade();
    await expect(f.as(SELLER).escrow.prepareFund({ tradeId: t.id })).rejects.toThrow(/Only a created escrow can be funded/);
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toThrow(/Only a funded escrow can be released/);
    await expect(f.as(SELLER).escrow.recordFund({ tradeId: t.id, txHash: HASH.fund })).rejects.toThrow(/Only a created escrow can be funded/);
    await expect(f.as(SELLER).escrow.recordRelease({ tradeId: t.id, txHash: HASH.release })).rejects.toThrow(/Only a funded escrow can be released/);
    await expect(f.as(SELLER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy })).rejects.toThrow(/No escrow creation was prepared/);
    expect(twCall).not.toHaveBeenCalled();
    expect(verifyEscrowTx).not.toHaveBeenCalled();
  });

  it("refuses a release while the escrow is disputed, and a second create or fund", async () => {
    const t = await fundedTrade();
    vi.mocked(twCall).mockClear();
    vi.setSystemTime(during(RELEASE, 5));
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toThrow(/Only an agreed trade gets an escrow/);
    await expect(f.as(SELLER).escrow.prepareFund({ tradeId: t.id })).rejects.toThrow(/already funded/);
    await set(t.id, { disputed: true, disputeTx: "e".repeat(64), disputedAt: new Date(), disputeRecordedAt: new Date(), disputeOpenedBy: "buyer" });
    vi.mocked(readEscrow).mockClear();
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toThrow(/in dispute/);
    // Pairy's own state check comes first: no chain read, no Trustless Work call.
    expect(readEscrow).not.toHaveBeenCalled();
    expect(twCall).not.toHaveBeenCalled();
  });

  it("lets an existing protected trade go on when PROTECTED_MODE is switched off", async () => {
    const t = await agreedTrade();
    vi.stubEnv("PROTECTED_MODE", "off");
    vi.setSystemTime(during(DEPLOY));
    prepared(DEPLOY);
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).resolves.toMatchObject({ contractId: ESCROW });
  });
});

describe("escrow.preflight and the create's checks", () => {
  const blocked = async (id: string) => {
    vi.setSystemTime(during(DEPLOY));
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: id, admin: ADMIN })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(twCall).not.toHaveBeenCalled();
  };

  it("blocks the create until the buyer can hold USDC (Trustless Work refuses the deploy with 422 otherwise)", async () => {
    const t = await agreedTrade();
    accounts[BUYER] = account({ xlm: "10" });
    const pre = await f.as(SELLER).escrow.preflight({ tradeId: t.id });
    expect(pre.ok).toBe(false);
    expect(pre.blockedReason).toMatch(/buyer needs to add a USDC trustline/);
    await blocked(t.id);
    accounts[BUYER] = null;
    expect((await f.as(SELLER).escrow.preflight({ tradeId: t.id })).blockedReason).toMatch(/buyer's account does not exist/);
  });

  it("blocks an arbiter account one signer could move alone, or that Horizon cannot show", async () => {
    const t = await agreedTrade();
    vi.mocked(arbiterAccountState).mockResolvedValue({
      masterWeight: 0,
      thresholds: { low: 2, med: 2, high: 2 },
      signers: [
        { key: OMER, weight: 2 },
        { key: ENSAR, weight: 1 },
      ],
    });
    const pre = await f.as(SELLER).escrow.preflight({ tradeId: t.id });
    expect(pre.checks.find((c) => c.id === "arbiterAccount")).toMatchObject({ ok: false, detail: expect.stringMatching(/one signer alone meets a threshold/) });
    await blocked(t.id);
    vi.mocked(arbiterAccountState).mockRejectedValue(new Error("503"));
    expect((await f.as(SELLER).escrow.preflight({ tradeId: t.id })).blockedReason).toMatch(/Couldn't check the arbiter account/);
  });

  it("blocks a platform account whose own key still signs or that lacks a USDC trustline", async () => {
    const t = await agreedTrade();
    accounts[PLATFORM_ACCOUNT] = account({ xlm: "10", usdc: "0", signers: [{ key: PLATFORM_ACCOUNT, weight: 1 }] });
    expect((await f.as(SELLER).escrow.preflight({ tradeId: t.id })).blockedReason).toMatch(/platform account/);
    accounts[PLATFORM_ACCOUNT] = account({ xlm: "10", signers: [{ key: PLATFORM_ACCOUNT, weight: 0 }] });
    expect((await f.as(SELLER).escrow.preflight({ tradeId: t.id })).blockedReason).toMatch(/platform account/);
    await blocked(t.id);
  });

  it("blocks a seller without the USDC or the XLM for the escrow's fees", async () => {
    const t = await agreedTrade();
    accounts[SELLER] = account({ xlm: "100", usdc: "4.9999999" });
    expect((await f.as(SELLER).escrow.preflight({ tradeId: t.id })).blockedReason).toMatch(/You need 5 USDC but hold 4.9999999 USDC/);
    accounts[SELLER] = account({ xlm: "3.4999999", usdc: "10" }); // 1.5 XLM minimum balance + 2 XLM for fees
    expect((await f.as(SELLER).escrow.preflight({ tradeId: t.id })).blockedReason).toMatch(/XLM/);
    await blocked(t.id);
    accounts[SELLER] = account({ xlm: "3.5", usdc: "10" });
    expect((await f.as(SELLER).escrow.preflight({ tradeId: t.id })).ok).toBe(true);
  });

  it("refuses a creation key that is not a new account of its own", async () => {
    const t = await agreedTrade();
    vi.setSystemTime(during(DEPLOY));
    for (const admin of [SELLER, BUYER, ARBITER_ACCOUNT, PLATFORM_ACCOUNT]) {
      await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin })).rejects.toThrow(/creation key must be a new account/);
    }
    const unfunded = Keypair.random().publicKey();
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: unfunded })).rejects.toThrow(/Fund it with Friendbot first/);
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ESCROW })).rejects.toThrow();
    expect(twCall).not.toHaveBeenCalled();
  });

  it("refuses with CONFLICT when another prepare stored its escrow while Trustless Work was answering this one", async () => {
    const t = await agreedTrade();
    vi.setSystemTime(during(DEPLOY));
    let other: unknown;
    // While Trustless Work answers the first prepare, a second one (past the 5 s throttle) runs to the end and stores its escrow.
    vi.mocked(twCall)
      .mockImplementationOnce(async () => {
        vi.setSystemTime(during(DEPLOY, 7));
        other = await f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN });
        return DEPLOY.response.body as never;
      })
      .mockResolvedValueOnce(DEPLOY.response.body as never);
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This trade changed while the escrow was being prepared. Reload the page.",
    });
    expect(other).toMatchObject({ contractId: ESCROW });
    expect(await row(t.id)).toMatchObject({ escrowAdmin: ADMIN, escrowContractId: ESCROW });
  });

  it("asks Trustless Work at most once every 5 seconds per trade", async () => {
    const t = await agreedTrade();
    vi.setSystemTime(during(DEPLOY));
    prepared(DEPLOY);
    await f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN });
    vi.setSystemTime(during(DEPLOY, 4));
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(twCall).toHaveBeenCalledTimes(1);
  });
});

describe("escrow.prepareCreate: replacing an earlier prepared creation (FIXES F-02)", () => {
  const EARLIER_ADMIN = "GDPDAXYC6DTRVDM2SBN24JQ4I2EKLSAGMUQ6FSNUYNXKZ566BXGENDYV";
  async function preparedEarlier(minutesAgo: number) {
    const t = await agreedTrade();
    await set(t.id, { escrowAdmin: EARLIER_ADMIN, escrowContractId: OTHER_ESCROW, escrowPreparedAt: new Date(during(DEPLOY).getTime() - minutesAgo * 60_000) });
    vi.setSystemTime(during(DEPLOY));
    return t;
  }

  it("is allowed when the earlier escrow does not exist and its creation key sent nothing", async () => {
    const t = await preparedEarlier(1);
    prepared(DEPLOY);
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).resolves.toMatchObject({ contractId: ESCROW });
    expect(readEscrow).toHaveBeenCalledWith(OTHER_ESCROW);
    expect(findEscrowTx).toHaveBeenCalledWith(EARLIER_ADMIN, "CCYOZX2IZBMFWN5MIMGQ7GAND7KSAIRCEC3LQSUS5CTSJ6SKKTTYL7GL", "tw_new_single_release_escrow", t.createdAt);
    expect(await row(t.id)).toMatchObject({ escrowAdmin: ADMIN, escrowContractId: ESCROW });
  });

  it("is refused while the earlier escrow exists on chain", async () => {
    const t = await preparedEarlier(30);
    chainHas({});
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toThrow(/already exists on Stellar testnet/);
    expect(twCall).not.toHaveBeenCalled();
  });

  it("is refused for 15 minutes after the earlier creation key sent a deploy, then allowed", async () => {
    vi.mocked(findEscrowTx).mockResolvedValue("d".repeat(64));
    const t = await preparedEarlier(14);
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toThrow(
      "An escrow creation was already sent. This page is checking the network.",
    );
    expect(twCall).not.toHaveBeenCalled();
    await set(t.id, { escrowPreparedAt: new Date(during(DEPLOY).getTime() - 16 * 60_000) });
    prepared(DEPLOY);
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).resolves.toMatchObject({ contractId: ESCROW });
  });

  it("is refused, not allowed, when Soroban RPC or Horizon cannot be read (C-5: only 'no contract' means none)", async () => {
    const t = await preparedEarlier(30);
    vi.mocked(readEscrow).mockRejectedValue(new Error("fetch failed"));
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toThrow(/Couldn't check/);
    // Inside the 15 minutes Horizon must answer whether the earlier key sent a deploy.
    chainHas(null);
    await set(t.id, { escrowPreparedAt: new Date(during(DEPLOY).getTime() - 60_000) });
    vi.mocked(findEscrowTx).mockRejectedValue(new Error("503"));
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toThrow(/Couldn't check/);
    expect(twCall).not.toHaveBeenCalled();
  });
});

describe("escrow: Trustless Work's answer is checked before it is returned (DECISIONS 7)", () => {
  it("refuses a deploy whose escrow address is not the one the transaction creates, and stores nothing", async () => {
    const t = await agreedTrade();
    vi.setSystemTime(during(DEPLOY));
    vi.mocked(twCall).mockResolvedValueOnce({ ...DEPLOY.response.body, contractId: OTHER_ESCROW } as never);
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toThrow(
      /Trustless Work returned a transaction Pairy won't ask you to sign: .*not the one this transaction creates/,
    );
    expect(await row(t.id)).toMatchObject({ escrowAdmin: null, escrowContractId: null });
    expect(log.mock.calls.flat().join()).toMatch(/"evt":"escrow.refused"/);
  });

  it("refuses a deploy for other roles than the trade's", async () => {
    const t = await agreedTrade();
    await set(t.id, { amount: "6" });
    vi.setSystemTime(during(DEPLOY));
    prepared(DEPLOY);
    await expect(f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN })).rejects.toThrow(/won't ask you to sign: .*amount/);
  });

  it("refuses another call in place of the fund", async () => {
    const t = await createdTrade();
    vi.setSystemTime(during(FUND));
    prepared(RELEASE);
    await expect(f.as(SELLER).escrow.prepareFund({ tradeId: t.id })).rejects.toThrow(/won't ask you to sign: .*calls approve_and_release_milestones, not fund_escrow/);
  });

  it("refuses another call in place of the release", async () => {
    const t = await fundedTrade();
    vi.setSystemTime(during(RELEASE, 5));
    prepared(FUND);
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toThrow(/won't ask you to sign: .*calls fund_escrow, not approve_and_release_milestones/);
  });

  it("refuses an answer that has expired by the time it arrives", async () => {
    const t = await createdTrade();
    vi.setSystemTime(during(FUND, 301));
    prepared(FUND);
    await expect(f.as(SELLER).escrow.prepareFund({ tradeId: t.id })).rejects.toThrow(/expired/);
  });

  it("refuses to fund an escrow that already holds USDC or whose terms changed", async () => {
    const t = await createdTrade();
    vi.setSystemTime(during(FUND));
    chainHas({ balance: 50_000_000n });
    await expect(f.as(SELLER).escrow.prepareFund({ tradeId: t.id })).rejects.toThrow(/already holds USDC/);
    chainHas({ terms: { ...terms, disputeResolvers: [OMER] } });
    await expect(f.as(SELLER).escrow.prepareFund({ tradeId: t.id })).rejects.toThrow(/dispute resolvers/);
    expect(vi.mocked(twCall).mock.calls.map(([ep]) => ep)).toEqual(["deploy"]);
  });
});

describe("escrow.prepareRelease reads the escrow on chain first (O-24)", () => {
  const DISPUTED_ESCROW = "CCYX2DAOGUDNCUCOZPPPKTHPYHHZXLA4I73POY66ULQHB7ANTZJSG6M2";

  it("refuses a release while the escrow is disputed on chain, though Pairy has not recorded the dispute", async () => {
    const t = await fundedTrade();
    // This funded trade's escrow, as far as the chain read goes, is WP-15's real dispute-buyer escrow mid-dispute.
    await set(t.id, { escrowContractId: DISPUTED_ESCROW });
    await chainRecorded("wp15-dispute-buyer-real");
    vi.mocked(twCall).mockClear();
    vi.setSystemTime(during(RELEASE, 5));
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "This trade has a dispute on chain; refresh the trade. Only the arbiter can settle it now.",
    });
    expect(readEscrow).toHaveBeenLastCalledWith(DISPUTED_ESCROW);
    expect(twCall).not.toHaveBeenCalled();
    // Recording the dispute is sync's job (WP-26); the refusal changes nothing.
    expect(await row(t.id)).toMatchObject({ state: "funded", disputed: false });
  });

  it("refuses a release the chain already shows settled, by a release or by the arbiter", async () => {
    const t = await fundedTrade();
    vi.mocked(twCall).mockClear();
    vi.setSystemTime(during(RELEASE, 5));
    await chainRecorded("gate-d2"); // Gate D2's escrow (this trade's), recorded after its release
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toThrow("This escrow is already settled on chain; refresh the trade.");
    const resolved = rpcRecording("wp03-b"); // WP-03's escrow B, recorded after its dispute was resolved
    await set(t.id, { escrowContractId: resolved.contractId });
    await chainRecorded("wp03-b");
    vi.setSystemTime(during(RELEASE, 11));
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toThrow("This escrow is already settled on chain; refresh the trade.");
    expect(twCall).not.toHaveBeenCalled();
  });

  it("refuses, not guesses, when Soroban RPC cannot be read", async () => {
    const t = await fundedTrade();
    vi.mocked(readEscrow).mockRejectedValue(new Error("fetch failed"));
    vi.mocked(twCall).mockClear();
    vi.setSystemTime(during(RELEASE, 5));
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Couldn't read the escrow from Stellar testnet; try again in a minute.",
    });
    expect(twCall).not.toHaveBeenCalled();
  });
});

describe("escrow: Trustless Work's refusals reach the trader as sentences", () => {
  it("maps a 4xx code through describeEscrowError and an outage to the retry sentence", async () => {
    const t = await fundedTrade();
    vi.setSystemTime(during(RELEASE, 5));
    const detail = "approve_and_release_milestones requires the signer to be in BOTH roles.approvers and roles.release_signers.";
    vi.mocked(twCall).mockRejectedValueOnce(
      new TwApiError("approveAndRelease", 403, detail, { code: "ESCROW_SIGNER_MUST_BE_APPROVER_AND_RELEASE_SIGNER", detail }),
    );
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Only the seller can release this escrow.",
    });

    vi.setSystemTime(during(RELEASE, 11));
    const RETRY = "Trustless Work isn't answering right now. Nothing was signed; try again in a minute.";
    vi.mocked(twCall).mockRejectedValueOnce(new TwApiError("approveAndRelease", 503, RETRY));
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: RETRY });

    vi.setSystemTime(during(RELEASE, 17));
    vi.mocked(twCall).mockRejectedValueOnce(new TwApiError("approveAndRelease", 0, RETRY));
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", message: RETRY });

    vi.setSystemTime(during(RELEASE, 23));
    const UNEXPECTED = "Trustless Work answered in an unexpected shape, so Pairy stopped. Nothing was signed.";
    vi.mocked(twCall).mockRejectedValueOnce(new TwApiError("approveAndRelease", 200, UNEXPECTED));
    await expect(f.as(SELLER).escrow.prepareRelease({ tradeId: t.id })).rejects.toMatchObject({ code: "BAD_GATEWAY", message: UNEXPECTED });
  });
});

describe("escrow.record*: the chain is read back before anything is recorded", () => {
  async function preparedCreate() {
    const t = await agreedTrade();
    vi.setSystemTime(during(DEPLOY));
    prepared(DEPLOY);
    await f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN });
    return t;
  }

  it("refuses a creation the transaction does not match, with the reason", async () => {
    const t = await preparedCreate();
    vi.mocked(verifyEscrowTx).mockRejectedValueOnce(new EscrowMismatchError(`Transaction ${HASH.fund} is not this trade's escrow creation: It calls fund_escrow.`));
    await expect(f.as(SELLER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.fund })).rejects.toThrow(/is not this trade's escrow creation/);
    expect((await row(t.id)).state).toBe("agreed");
  });

  it("refuses a creation whose escrow on chain has other terms or other code", async () => {
    const t = await preparedCreate();
    const landed = { createdAt: new Date("2026-11-24T08:27:57Z"), signer: ADMIN, contractId: ESCROW, transfers: [] };
    vi.mocked(verifyEscrowTx).mockResolvedValue(landed);
    chainHas({ terms: { ...terms, receiver: OMER } });
    await expect(f.as(SELLER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy })).rejects.toThrow(/receiver is GDRJ/);
    chainHas({});
    vi.mocked(readWasmHash).mockResolvedValueOnce("0".repeat(64));
    await expect(f.as(SELLER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy })).rejects.toThrow(/runs contract code 0000/);
    chainHas(null);
    await expect(f.as(SELLER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy })).rejects.toThrow(/doesn't show the new escrow yet/);
    expect((await row(t.id)).state).toBe("agreed");
    chainHas({});
    await expect(f.as(SELLER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy })).resolves.toMatchObject({ state: "escrow_created" });
  });

  it("says a Horizon outage is an outage", async () => {
    const t = await preparedCreate();
    vi.mocked(verifyEscrowTx).mockRejectedValueOnce(new Error("socket hang up"));
    await expect(f.as(SELLER).escrow.recordCreate({ tradeId: t.id, txHash: HASH.deploy })).rejects.toThrow(/Could not reach Stellar testnet/);
  });

  it("records a fund found after the trade was cancelled: the chain wins", async () => {
    const t = await createdTrade();
    await f.as(BUYER).trade.cancel({ tradeId: t.id });
    vi.mocked(verifyEscrowTx).mockResolvedValueOnce({
      createdAt: new Date("2026-11-24T08:28:02Z"),
      signer: SELLER,
      contractId: ESCROW,
      transfers: [{ from: SELLER, to: ESCROW, amountStroops: 50_000_000n }],
    });
    await expect(f.as(SELLER).escrow.recordFund({ tradeId: t.id, txHash: HASH.fund })).resolves.toMatchObject({ state: "funded" });
    expect((await f.db.select().from(listings).where(eq(listings.id, f.listing.id)))[0].remainingAmount).toBe("95.0000000");
  });

  it("records a release whose fee went elsewhere, and logs it (F-10)", async () => {
    const t = await fundedTrade();
    vi.mocked(verifyEscrowTx).mockResolvedValueOnce({ ...RELEASED, transfers: [{ ...RELEASED.transfers[0], to: OMER }, RELEASED.transfers[1]] });
    await expect(f.as(SELLER).escrow.recordRelease({ tradeId: t.id, txHash: HASH.release })).resolves.toMatchObject({ state: "released" });
    expect(log.mock.calls.flat().join()).toMatch(/"evt":"escrow.fee_mismatch"/);
  });
});

describe("trade.byId on a protected trade", () => {
  it("links the escrow on Trustless Work's viewer once it exists, and nudges 72 h after funding", async () => {
    const t = await agreedTrade();
    expect(await f.as(BUYER).trade.byId({ id: t.id })).toMatchObject({ viewerUrl: null, stallNudge: false });
    await fundedTrade().then(async (funded) => {
      expect(await f.as(SELLER).trade.byId({ id: funded.id })).toMatchObject({ viewerUrl: `${TW_VIEWER_BASE}/testnet/v2/${ESCROW}`, stallNudge: false });
      vi.setSystemTime(new Date(Date.parse("2026-11-24T08:28:02Z") + 72 * 3600_000 + 1000));
      expect((await f.as(SELLER).trade.byId({ id: funded.id })).stallNudge).toBe(true);
    });
  });
});

// ---- Part 2 (WP-26): disputes, answers, and cancelling a protected trade ----

/**
 * WP-15's second test-arbiter run (scripts/evidence/out/escrow-dispute-*-test.json):
 * in the buyer exit the buyer disputed, in the seller exit the seller. Their
 * Trustless Work dispute answers are the recorded fixtures, so the server's own
 * validateEscrowCall runs on real dispute transactions.
 */
const DISPUTES = {
  buyer: {
    seller: "GBHJ2SXQHGE44MWYUELDSLP3CCMYPA4RFNFIOAKHI6TC5SZJ4I6J6G3E",
    buyer: "GB4SRNTZC2IPDRHBQMAMHVRNUOEUEIGLJKPP7SXBLRYKD4EC6RMJ34TT",
    contractId: "CD2SQ73L66QEHOZTFZ3EVTEHQCOP64KSC4KZHFMB2NMRKACSTIF5EAXX",
    prepared: tw("exits-test-dispute-buyer"),
  },
  seller: {
    seller: "GDK5RUFARH53VBUNAX7VWGV2PWYCLSWN45CRE4YBZYM5XHV2KM64LAYI",
    buyer: "GBBLEBFJQQ2GLDVB4GIGLJ2D5W5N7GOEJVJO6CXHPKYVLISDVNLJ3SVI",
    contractId: "CDAITJCFLGRYDPQBTMEJU2MDU24KWZA5W245PEES272DCYGE3VMFJKTM",
    prepared: tw("exits-test-dispute-seller"),
  },
} as const;
type DisputeRun = (typeof DISPUTES)[keyof typeof DISPUTES];
const DISPUTE_HASH = "d".repeat(64);

/** A funded protected trade between a dispute run's two traders, on its escrow, written straight into the database. */
async function fundedBetween(run: DisputeRun, values: Partial<typeof trades.$inferInsert> = {}) {
  await f.db.insert(users).values([run.seller, run.buyer].map((publicKey) => ({ publicKey }))).onConflictDoNothing();
  const [listing] = await f.db
    .insert(listings)
    .values({ ...(await f.db.select().from(listings).where(eq(listings.id, f.listing.id)))[0], id: undefined, owner: run.seller, remainingAmount: "95" })
    .returning();
  const [t] = await f.db
    .insert(trades)
    .values({
      listingId: listing.id,
      seller: run.seller,
      buyer: run.buyer,
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
      escrowAdmin: ADMIN,
      escrowContractId: run.contractId,
      createTx: "1".repeat(64),
      fundTx: "2".repeat(64),
      fundedAt: new Date("2026-11-24T09:07:30Z"),
      state: "funded",
      ...values,
    })
    .returning();
  return t;
}

/** A dispute Pairy recorded `hoursAgo` hours ago; its transaction landed two days ago. */
const disputed = (hoursAgo: number, by: "seller" | "buyer" = "buyer") => ({
  disputed: true,
  disputeTx: DISPUTE_HASH,
  disputedAt: new Date(Date.now() - 48 * 3600_000),
  disputeRecordedAt: new Date(Date.now() - hoursAgo * 3600_000),
  disputeOpenedBy: by,
});

describe("escrow.prepareDispute", () => {
  it("lets either trader dispute, asking Trustless Work for that trader with Pairy's fixed reason, and checks the answer", async () => {
    for (const [who, run] of [
      ["buyer", DISPUTES.buyer],
      ["seller", DISPUTES.seller],
    ] as const) {
      const t = await fundedBetween(run);
      vi.setSystemTime(during(run.prepared));
      chainHas({ balance: 50_000_000n });
      prepared(run.prepared);
      const out = await f.as(run[who]).escrow.prepareDispute({ tradeId: t.id });
      expect(twCall).toHaveBeenLastCalledWith(
        "dispute",
        { contractId: run.contractId, signer: run[who], reason: "Pairy protected trade: a trader opened a dispute." },
        { tradeId: t.id },
      );
      expect(out).toEqual({ unsignedXdr: run.prepared.response.body.unsignedXdr, txHash: run.prepared.response.body.txHash, summary: "Open a dispute on this trade's escrow" });
    }
  });

  it("refuses Trustless Work's dispute when it is for the other trader", async () => {
    const run = DISPUTES.buyer;
    const t = await fundedBetween(run);
    vi.setSystemTime(during(run.prepared));
    chainHas({ balance: 50_000_000n });
    prepared(run.prepared);
    await expect(f.as(run.seller).escrow.prepareDispute({ tradeId: t.id })).rejects.toThrow(/won't ask you to sign: .*not from GBHJ/);
  });

  it("refuses a step the trade is not at before asking Trustless Work: not funded, already disputed, ended, or not a trader's", async () => {
    const run = DISPUTES.buyer;
    vi.setSystemTime(during(run.prepared));
    chainHas({ balance: 50_000_000n });
    const created = await fundedBetween(run, { state: "escrow_created", fundTx: null, fundedAt: null });
    await expect(f.as(run.buyer).escrow.prepareDispute({ tradeId: created.id })).rejects.toThrow(/Only a funded escrow can be disputed/);
    await set(created.id, { state: "funded", fundTx: "2".repeat(64), fundedAt: new Date(), ...disputed(1) });
    await expect(f.as(run.buyer).escrow.prepareDispute({ tradeId: created.id })).rejects.toThrow(/already in dispute/);
    await set(created.id, { state: "resolved_seller", resolveTx: "3".repeat(64), resolvedAt: new Date() });
    await expect(f.as(run.buyer).escrow.prepareDispute({ tradeId: created.id })).rejects.toThrow(/Only a funded escrow can be disputed/);
    await expect(f.as(f.stranger).escrow.prepareDispute({ tradeId: created.id })).rejects.toThrow(/Trade not found/);
    const claimable = await f.as(BUYER).trade.open({ listingId: f.listing.id, amount: "5" });
    await expect(f.as(SELLER).escrow.prepareDispute({ tradeId: claimable.id })).rejects.toThrow(/not a protected trade/);
    expect(twCall).not.toHaveBeenCalled();
  });

  it("reads the escrow first: a dispute or a settlement already on chain, or no answer from Soroban RPC, is refused before Trustless Work", async () => {
    const run = DISPUTES.buyer;
    const t = await fundedBetween(run);
    vi.setSystemTime(during(run.prepared));
    await set(t.id, { escrowContractId: "CCYX2DAOGUDNCUCOZPPPKTHPYHHZXLA4I73POY66ULQHB7ANTZJSG6M2" });
    await chainRecorded("wp15-dispute-buyer-real"); // the day-12 gate's buyer exit, mid-dispute
    await expect(f.as(run.seller).escrow.prepareDispute({ tradeId: t.id })).rejects.toThrow("This trade already has a dispute on chain; refresh the trade.");
    vi.unstubAllGlobals();
    chainHas({ balance: 0n });
    vi.mocked(readEscrow).mockResolvedValue({ ...(await readEscrow(ESCROW)), status: { disputed: false, released: true, resolved: false, balanceStroops: 0n } });
    await expect(f.as(run.buyer).escrow.prepareDispute({ tradeId: t.id })).rejects.toThrow("This escrow is already settled on chain; refresh the trade.");
    vi.mocked(readEscrow).mockRejectedValue(new Error("fetch failed"));
    await expect(f.as(run.buyer).escrow.prepareDispute({ tradeId: t.id })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Couldn't read the escrow from Stellar testnet; try again in a minute.",
    });
    expect(twCall).not.toHaveBeenCalled();
  });
});

describe("escrow.recordDispute", () => {
  const landed = (signer: string, contractId: string) => ({ createdAt: new Date("2026-11-24T09:07:50Z"), signer, contractId, transfers: [] });

  it("records the dispute from the chain: who signed it, its ledger time, and when Pairy recorded it (DECISIONS 1)", async () => {
    const run = DISPUTES.buyer;
    const t = await fundedBetween(run);
    vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
    vi.mocked(verifyEscrowTx).mockResolvedValueOnce(landed(run.buyer, run.contractId));
    // Either trader may report it; the transaction says who opened it.
    const out = await f.as(run.seller).escrow.recordDispute({ tradeId: t.id, txHash: DISPUTE_HASH });
    expect(verifyEscrowTx).toHaveBeenLastCalledWith(DISPUTE_HASH, { kind: "dispute", contractId: run.contractId, parties: { seller: run.seller, buyer: run.buyer } });
    expect(out).toMatchObject({
      state: "funded",
      disputed: true,
      disputeTx: DISPUTE_HASH,
      disputedAt: new Date("2026-11-24T09:07:50Z"),
      disputeRecordedAt: new Date("2026-11-24T12:00:00Z"),
      disputeOpenedBy: "buyer",
    });
    const events = (await f.as(run.buyer).trade.byId({ id: t.id })).events.map((e) => [e.type, e.by, e.txHash]);
    expect(events.at(-1)).toEqual(["escrowDispute", "buyer", DISPUTE_HASH]);
  });

  it("is idempotent for the same hash and refuses a second dispute", async () => {
    const run = DISPUTES.seller;
    const t = await fundedBetween(run);
    vi.mocked(verifyEscrowTx).mockResolvedValueOnce(landed(run.seller, run.contractId));
    await f.as(run.seller).escrow.recordDispute({ tradeId: t.id, txHash: DISPUTE_HASH });
    vi.mocked(verifyEscrowTx).mockClear();
    await expect(f.as(run.buyer).escrow.recordDispute({ tradeId: t.id, txHash: DISPUTE_HASH.toUpperCase() })).resolves.toMatchObject({ disputeOpenedBy: "seller" });
    await expect(f.as(run.buyer).escrow.recordDispute({ tradeId: t.id, txHash: "e".repeat(64) })).rejects.toThrow(/already recorded/);
    expect(verifyEscrowTx).not.toHaveBeenCalled();
  });

  it("refuses a trade with no funded escrow before reading the chain, and a transaction that is not this dispute", async () => {
    const run = DISPUTES.buyer;
    const t = await fundedBetween(run, { state: "escrow_created", fundTx: null, fundedAt: null });
    await expect(f.as(run.buyer).escrow.recordDispute({ tradeId: t.id, txHash: DISPUTE_HASH })).rejects.toThrow(/Only a funded escrow can be disputed/);
    expect(verifyEscrowTx).not.toHaveBeenCalled();
    await set(t.id, { state: "funded", fundTx: "2".repeat(64), fundedAt: new Date() });
    vi.mocked(verifyEscrowTx).mockRejectedValueOnce(new EscrowMismatchError(`Transaction ${DISPUTE_HASH} is not this trade's escrow dispute: It calls fund_escrow.`));
    await expect(f.as(run.buyer).escrow.recordDispute({ tradeId: t.id, txHash: DISPUTE_HASH })).rejects.toThrow(/is not this trade's escrow dispute/);
    expect(await row(t.id)).toMatchObject({ disputed: false, disputeTx: null });
  });
});

describe("escrow.answer: one answer per side, within 24 hours of Pairy recording the dispute", () => {
  const run = DISPUTES.buyer;

  it("saves each side's one answer and never changes it (DECISIONS 10)", async () => {
    const t = await fundedBetween(run, disputed(1));
    await f.as(run.seller).escrow.answer({ tradeId: t.id, cashHandedOver: true, note: "  He paid me at the cafe.  " });
    await f.as(run.buyer).escrow.answer({ tradeId: t.id, cashHandedOver: false });
    await expect(f.as(run.seller).escrow.answer({ tradeId: t.id, cashHandedOver: false })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "You already answered." });
    const saved = await f.db.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, t.id));
    expect(saved.map((a) => [a.role, a.cashHandedOver, a.note]).sort()).toEqual([
      ["buyer", false, null],
      ["seller", true, "He paid me at the cafe."],
    ]);
    const events = (await f.as(run.buyer).trade.byId({ id: t.id })).events.map((e) => [e.type, e.by]);
    expect(events).toEqual([
      ["answerYes", "seller"],
      ["answerNo", "buyer"],
    ]);
  });

  it("counts the 24 hours from when Pairy recorded the dispute, not from its ledger time", async () => {
    // The dispute landed two days ago but Pairy recorded it 23 h 59 min ago: still open.
    const t = await fundedBetween(run, disputed(23 + 59 / 60));
    await expect(f.as(run.buyer).escrow.answer({ tradeId: t.id, cashHandedOver: true })).resolves.toBeDefined();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await expect(f.as(run.seller).escrow.answer({ tradeId: t.id, cashHandedOver: true })).rejects.toThrow(/Answers closed at/);
    expect(await f.db.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, t.id))).toHaveLength(1);
  });

  it("is refused without a dispute, on an ended trade, for a stranger, and on a claimable trade", async () => {
    const t = await fundedBetween(run);
    await expect(f.as(run.buyer).escrow.answer({ tradeId: t.id, cashHandedOver: true })).rejects.toThrow(/no open dispute/);
    await set(t.id, { ...disputed(1), state: "resolved_seller", resolveTx: "3".repeat(64), resolvedAt: new Date() });
    await expect(f.as(run.buyer).escrow.answer({ tradeId: t.id, cashHandedOver: true })).rejects.toThrow(/no open dispute/);
    await expect(f.as(f.stranger).escrow.answer({ tradeId: t.id, cashHandedOver: true })).rejects.toThrow(/Trade not found/);
    const claimable = await f.as(BUYER).trade.open({ listingId: f.listing.id, amount: "5" });
    await expect(f.as(BUYER).escrow.answer({ tradeId: claimable.id, cashHandedOver: true })).rejects.toThrow(/not a protected trade/);
  });

  it("takes a note of up to 500 characters with no NUL; a blank note is none", async () => {
    const t = await fundedBetween(run, disputed(1));
    await expect(f.as(run.buyer).escrow.answer({ tradeId: t.id, cashHandedOver: true, note: "x".repeat(501) })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(f.as(run.buyer).escrow.answer({ tradeId: t.id, cashHandedOver: true, note: "a\0b" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await f.as(run.buyer).escrow.answer({ tradeId: t.id, cashHandedOver: true, note: "   " });
    await f.as(run.seller).escrow.answer({ tradeId: t.id, cashHandedOver: false, note: "y".repeat(500) });
    const saved = await f.db.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, t.id));
    expect(saved.map((a) => [a.role, a.note?.length ?? null]).sort()).toEqual([
      ["buyer", null],
      ["seller", 500],
    ]);
  });

  it("an answer after the trade ended is refused; one saved before it loses its note with the chat (FOR SHARE, both orders)", async () => {
    const t = await fundedBetween(run, disputed(1));
    await f.as(run.seller).escrow.answer({ tradeId: t.id, cashHandedOver: true, note: "Paid in full." });
    await transitionTrade(f.db, t.id, { type: "resolve", by: "arbiter", outcome: "buyer", txHash: "3".repeat(64), resolvedAt: new Date() });
    await expect(f.as(run.buyer).escrow.answer({ tradeId: t.id, cashHandedOver: true, note: "Too late?" })).rejects.toThrow(/no open dispute/);
    const saved = await f.db.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, t.id));
    expect(saved.map((a) => [a.role, a.cashHandedOver, a.note])).toEqual([["seller", true, null]]);
  });
});

describe("trade.byId and trade.mine on a disputed protected trade", () => {
  it("show both answers and both notes to both traders, the answer deadline and the arbiter's promise", async () => {
    const run = DISPUTES.buyer;
    const t = await fundedBetween(run);
    for (const who of [run.seller, run.buyer]) {
      expect(await f.as(who).trade.byId({ id: t.id })).toMatchObject({ answers: { seller: null, buyer: null }, answerDeadline: null, promiseDeadline: null });
    }
    await set(t.id, disputed(2));
    const recorded = (await row(t.id)).disputeRecordedAt!;
    await f.as(run.seller).escrow.answer({ tradeId: t.id, cashHandedOver: false, note: "Never saw the buyer." });
    for (const who of [run.seller, run.buyer]) {
      const room = await f.as(who).trade.byId({ id: t.id });
      expect(room).toMatchObject({
        answers: { seller: { cashHandedOver: false, note: "Never saw the buyer.", answeredAt: expect.any(Date) }, buyer: null },
        answerDeadline: new Date(recorded.getTime() + 24 * 3600_000),
        promiseDeadline: new Date((await row(t.id)).disputedAt!.getTime() + 72 * 3600_000),
      });
      const [listed] = (await f.as(who).trade.mine()).filter((m) => m.id === t.id);
      expect(listed).toMatchObject({ answers: room.answers, answerDeadline: room.answerDeadline, promiseDeadline: room.promiseDeadline });
    }
  });
});

describe("trade.byId's answersOpen: the answer form follows the server's clock (O-34)", () => {
  it("is true only while escrow.answer would take an answer: from the recorded dispute until 24 hours later", async () => {
    const run = DISPUTES.buyer;
    const t = await fundedBetween(run);
    expect((await f.as(run.buyer).trade.byId({ id: t.id })).answersOpen).toBe(false);
    await set(t.id, disputed(0));
    const deadline = (await row(t.id)).disputeRecordedAt!.getTime() + 24 * 3600_000;

    vi.setSystemTime(new Date(deadline - 1000));
    for (const who of [run.seller, run.buyer]) expect((await f.as(who).trade.byId({ id: t.id })).answersOpen).toBe(true);
    await expect(f.as(run.buyer).escrow.answer({ tradeId: t.id, cashHandedOver: true })).resolves.toBeDefined();
    // Still open for the side that has not answered: the flag is the window's, not the viewer's.
    expect((await f.as(run.buyer).trade.byId({ id: t.id })).answersOpen).toBe(true);

    vi.setSystemTime(new Date(deadline));
    for (const who of [run.seller, run.buyer]) expect((await f.as(who).trade.byId({ id: t.id })).answersOpen).toBe(false);
    await expect(f.as(run.seller).escrow.answer({ tradeId: t.id, cashHandedOver: false })).rejects.toThrow(/Answers closed at/);
  });

  it("is false wherever escrow.answer refuses: an undisputed or ended trade", async () => {
    const run = DISPUTES.buyer;
    const t = await fundedBetween(run, disputed(1));
    expect((await f.as(run.seller).trade.byId({ id: t.id })).answersOpen).toBe(true);
    await set(t.id, { disputed: false });
    expect((await f.as(run.seller).trade.byId({ id: t.id })).answersOpen).toBe(false);
    await expect(f.as(run.seller).escrow.answer({ tradeId: t.id, cashHandedOver: true })).rejects.toThrow(/no open dispute/);
    await set(t.id, { disputed: true, state: "resolved_seller", resolveTx: "3".repeat(64), resolvedAt: new Date() });
    expect((await f.as(run.seller).trade.byId({ id: t.id })).answersOpen).toBe(false);
  });
});

describe("trade.mine: each trade's own answers and deadlines (WP-31 judge)", () => {
  it("lets the list tell whether the viewer answered, trade by trade, in byId's shape", async () => {
    const run = DISPUTES.buyer;
    // Two disputed trades between the same traders, and one funded trade with no dispute.
    const answered = await fundedBetween(run, disputed(2));
    const open = await fundedBetween(run, { ...disputed(1), escrowContractId: DISPUTES.seller.contractId });
    const quiet = await fundedBetween(run, { escrowContractId: OTHER_ESCROW });
    await f.as(run.seller).escrow.answer({ tradeId: answered.id, cashHandedOver: true, note: "Paid in full." });

    for (const who of [run.seller, run.buyer]) {
      const listed = new Map((await f.as(who).trade.mine()).map((m) => [m.id, m]));
      for (const t of [answered, open, quiet]) {
        const room = await f.as(who).trade.byId({ id: t.id });
        expect(listed.get(t.id)).toMatchObject({ answers: room.answers, answerDeadline: room.answerDeadline, promiseDeadline: room.promiseDeadline });
      }
      // The seller's answer shows on that trade only; the other dispute still waits for both.
      expect(listed.get(answered.id)!.answers).toEqual({
        seller: { cashHandedOver: true, note: "Paid in full.", answeredAt: expect.any(Date) },
        buyer: null,
      });
      expect(listed.get(open.id)).toMatchObject({ answers: { seller: null, buyer: null }, answerDeadline: expect.any(Date), promiseDeadline: expect.any(Date) });
      expect(listed.get(quiet.id)).toMatchObject({ answers: { seller: null, buyer: null }, answerDeadline: null, promiseDeadline: null });
    }
  });
});

describe("trade.cancel on a protected trade checks the chain first", () => {
  const FUNDED_SENTENCE = "This escrow is already funded. A dispute is the way to a refund.";

  it("lets the buyer cancel a created escrow that holds nothing, after reading it (F-16)", async () => {
    const t = await createdTrade();
    vi.mocked(readEscrow).mockClear();
    chainHas({ balance: 0n });
    await expect(f.as(BUYER).trade.cancel({ tradeId: t.id })).resolves.toMatchObject({ state: "cancelled" });
    expect(readEscrow).toHaveBeenCalledWith(ESCROW);
    expect((await f.db.select().from(listings).where(eq(listings.id, f.listing.id)))[0].remainingAmount).toBe("100.0000000");
  });

  it("refuses with the funded sentence when the escrow holds the amount, recording the fund when it finds it", async () => {
    const t = await createdTrade();
    chainHas({ balance: 50_000_000n });
    // The fund is on chain but Horizon does not show it yet: still refused, nothing recorded.
    await expect(f.as(BUYER).trade.cancel({ tradeId: t.id })).rejects.toThrow(FUNDED_SENTENCE);
    expect(await row(t.id)).toMatchObject({ state: "escrow_created" });
    // Found: the fund is recorded, and the cancel is still refused.
    vi.mocked(findEscrowTx).mockResolvedValue(HASH.fund);
    vi.mocked(verifyEscrowTx).mockResolvedValueOnce({
      createdAt: new Date("2026-11-24T08:28:02Z"),
      signer: SELLER,
      contractId: ESCROW,
      transfers: [{ from: SELLER, to: ESCROW, amountStroops: 50_000_000n }],
    });
    await expect(f.as(SELLER).trade.cancel({ tradeId: t.id })).rejects.toThrow(FUNDED_SENTENCE);
    expect(await row(t.id)).toMatchObject({ state: "funded", fundTx: HASH.fund });
  });

  it("refuses a recorded funded trade with the same funded sentence, disputed or not, without reading the chain (O-27)", async () => {
    const t = await fundedTrade();
    vi.mocked(readEscrow).mockClear();
    for (const who of [BUYER, SELLER]) {
      await expect(f.as(who).trade.cancel({ tradeId: t.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: FUNDED_SENTENCE });
    }
    await set(t.id, { disputed: true, disputeTx: "e".repeat(64), disputedAt: new Date(), disputeRecordedAt: new Date(), disputeOpenedBy: "buyer" });
    await expect(f.as(BUYER).trade.cancel({ tradeId: t.id })).rejects.toMatchObject({ code: "BAD_REQUEST", message: FUNDED_SENTENCE });
    expect(readEscrow).not.toHaveBeenCalled();
    expect(await row(t.id)).toMatchObject({ state: "funded" });
  });

  it("refuses, not guesses, when the escrow cannot be read", async () => {
    const t = await createdTrade();
    vi.mocked(readEscrow).mockRejectedValue(new Error("fetch failed"));
    await expect(f.as(BUYER).trade.cancel({ tradeId: t.id })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(await row(t.id)).toMatchObject({ state: "escrow_created" });
  });

  describe("while a prepared escrow creation is outstanding (O-23)", () => {
    async function preparedTrade() {
      const t = await agreedTrade();
      vi.setSystemTime(during(DEPLOY));
      prepared(DEPLOY);
      await f.as(SELLER).escrow.prepareCreate({ tradeId: t.id, admin: ADMIN });
      return t;
    }

    it("is refused until the prepared deploy has expired, then allowed once Soroban RPC shows no contract", async () => {
      const t = await preparedTrade();
      chainHas(null);
      vi.setSystemTime(during(DEPLOY, 300));
      await expect(f.as(BUYER).trade.cancel({ tradeId: t.id })).rejects.toThrow(/may still land on Stellar testnet/);
      vi.setSystemTime(during(DEPLOY, 400));
      await expect(f.as(BUYER).trade.cancel({ tradeId: t.id })).resolves.toMatchObject({ state: "cancelled" });
      expect(readEscrow).toHaveBeenLastCalledWith(ESCROW);
    });

    it("records the escrow first when the deploy landed, then follows the created escrow's rule", async () => {
      const t = await preparedTrade();
      chainHas({});
      vi.setSystemTime(during(DEPLOY, 30));
      vi.mocked(findEscrowTx).mockResolvedValue(HASH.deploy);
      vi.mocked(verifyEscrowTx).mockResolvedValueOnce({ createdAt: new Date("2026-11-24T08:27:57Z"), signer: ADMIN, contractId: ESCROW, transfers: [] });
      await expect(f.as(SELLER).trade.cancel({ tradeId: t.id })).resolves.toMatchObject({ state: "cancelled", createTx: HASH.deploy });
      expect(findEscrowTx).toHaveBeenCalledWith(ADMIN, "CCYOZX2IZBMFWN5MIMGQ7GAND7KSAIRCEC3LQSUS5CTSJ6SKKTTYL7GL", "tw_new_single_release_escrow", t.createdAt);
      const events = (await f.as(BUYER).trade.byId({ id: t.id })).events.map((e) => e.type);
      expect(events.slice(-2)).toEqual(["escrowCreate", "cancel"]);
    });

    it("is refused while the escrow exists on chain but its deploy cannot be placed yet", async () => {
      const t = await preparedTrade();
      chainHas({});
      vi.setSystemTime(during(DEPLOY, 400));
      await expect(f.as(BUYER).trade.cancel({ tradeId: t.id })).rejects.toThrow(/escrow exists on Stellar testnet/);
      expect(await row(t.id)).toMatchObject({ state: "agreed" });
    });
  });
});
