// SOW D2/D3 evidence: per-deal chat is purged server-side the moment a trade
// reaches a terminal state (claimed, reclaimed or cancelled; for a protected
// trade also released, resolved_buyer and resolved_seller, which clear the
// dispute notes too while the yes/no answers stay). Each case drives the
// trade through the real tRPC routers; only the chain is mocked: the Horizon
// read-back (verify.ts, lib/escrow/verify.ts), the escrow read from Soroban
// RPC (lib/escrow/read.ts) and Trustless Work (server/tw/client.ts).

import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatMessages, disputeAnswers, listings, trades } from "@/lib/db/schema";
import { ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { ARBITER_ACCOUNT, TW_ESCROW_WASM_HASH } from "@/lib/escrow/config";
import { readEscrow, readWasmHash } from "@/lib/escrow/read";
import { expectedTerms } from "@/lib/escrow/terms";
import { findEscrowTx, verifyEscrowTx } from "@/lib/escrow/verify";
import { verifyClaimTx, verifyLockTx } from "@/lib/stellar/verify";
import { TX, tradeFixture } from "@/lib/trade/test-helpers";
import { twCall } from "@/server/tw/client";

vi.mock("@/lib/stellar/verify", async (orig) => ({ ...(await orig<typeof import("@/lib/stellar/verify")>()), verifyLockTx: vi.fn(), verifyClaimTx: vi.fn(), findLockTx: vi.fn(async () => null), findClaimTx: vi.fn(async () => null) }));
vi.mock("@/lib/escrow/verify", async (orig) => ({ ...(await orig<typeof import("@/lib/escrow/verify")>()), verifyEscrowTx: vi.fn(), findEscrowTx: vi.fn(async () => null) }));
vi.mock("@/lib/escrow/read", async (orig) => ({ ...(await orig<typeof import("@/lib/escrow/read")>()), readEscrow: vi.fn(), readWasmHash: vi.fn() }));
vi.mock("@/server/tw/client", async (orig) => ({ ...(await orig<typeof import("@/server/tw/client")>()), twCall: vi.fn() }));
vi.mock("@/server/api/arbiter-auth", async (orig) => ({ ...(await orig<typeof import("@/server/api/arbiter-auth")>()), isArbiterSigner: vi.fn(async () => false) }));

let f: Awaited<ReturnType<typeof tradeFixture>>;

beforeEach(async () => {
  f = await tradeFixture();
  vi.stubEnv("PROTECTED_MODE", "on");
  vi.mocked(twCall).mockReset().mockRejectedValue(new Error("no Trustless Work call is needed to record a step"));
  vi.mocked(verifyEscrowTx).mockReset();
  vi.mocked(findEscrowTx).mockReset().mockResolvedValue(null);
  vi.mocked(readWasmHash).mockReset().mockResolvedValue(TW_ESCROW_WASM_HASH!);
  vi.mocked(readEscrow).mockReset();
});

afterEach(() => vi.unstubAllEnvs());

async function chatCount(tradeId: string): Promise<number> {
  const { rows } = await f.client.query<{ n: number }>(
    "select count(*)::int as n from chat_messages where trade_id = $1",
    [tradeId],
  );
  return rows[0].n;
}

/** Opens a trade and has both sides talk in it. */
async function tradeWithChat(): Promise<string> {
  const { id } = await f.as(f.taker).trade.open({ listingId: f.listing.id, amount: "20" });
  await f.as(f.taker).chat.send({ tradeId: id, body: "Meet at the station?" });
  await f.as(f.owner).chat.send({ tradeId: id, body: "See you at 3" });
  await f.as(f.taker).chat.send({ tradeId: id, body: "On my way" });
  return id;
}

async function lock(tradeId: string, balanceId: string) {
  vi.mocked(verifyLockTx).mockResolvedValueOnce({ balanceId, createdAt: new Date() });
  await f.as(f.owner).trade.agree({ tradeId });
  await f.as(f.owner).trade.recordLock({ tradeId, txHash: balanceId.slice(-64) });
}

const terminals: [string, (tradeId: string) => Promise<void>][] = [
  [
    "claimed",
    async (id) => {
      await lock(id, "00000000" + "1".repeat(64));
      vi.mocked(verifyClaimTx).mockResolvedValueOnce({ claimant: f.taker });
      await f.as(f.taker).trade.recordClaim({ tradeId: id, txHash: TX.claim });
    },
  ],
  [
    "reclaimed",
    async (id) => {
      await lock(id, "00000000" + "2".repeat(64));
      vi.mocked(verifyClaimTx).mockResolvedValueOnce({ claimant: f.owner });
      await f.as(f.owner).trade.recordClaim({ tradeId: id, txHash: TX.reclaim });
    },
  ],
  [
    "cancelled",
    async (id) => {
      await f.as(f.owner).trade.agree({ tradeId: id });
      await f.as(f.taker).trade.cancel({ tradeId: id });
    },
  ],
];

describe("coordination-purge-on-terminal", () => {
  it.each(terminals)("deletes every chat row when the trade is %s", async (state, finish) => {
    const tradeId = await tradeWithChat();
    const bystander = await tradeWithChat();
    expect(await chatCount(tradeId)).toBe(3);

    await finish(tradeId);

    expect((await f.as(f.taker).trade.byId({ id: tradeId })).state).toBe(state);
    expect(await chatCount(tradeId)).toBe(0);
    // A different live trade's chat is untouched.
    expect(await chatCount(bystander)).toBe(3);
    const [{ n }] = await f.db.select({ n: sql<number>`count(*)::int` }).from(chatMessages);
    expect(n).toBe(3);
  });

  it("keeps chat on non-terminal transitions, including a dispute flag", async () => {
    const tradeId = await tradeWithChat();
    await lock(tradeId, "00000000" + "3".repeat(64));
    await f.as(f.taker).trade.flagDispute({ tradeId });
    expect(await chatCount(tradeId)).toBe(3);
  });
});

// ---- Protected trades (D2 §10.2) ----

const ADMIN = "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5";
const ESCROW = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const at = () => new Date();

/** What Soroban RPC shows for the trade's escrow. */
function chainShows(status: { disputed?: boolean; released?: boolean; resolved?: boolean; balanceStroops?: bigint }) {
  vi.mocked(readEscrow).mockResolvedValue({
    terms: expectedTerms({ buyer: f.taker, seller: f.owner, amount: "20", escrowAdmin: ADMIN }),
    status: { disputed: false, released: false, resolved: false, balanceStroops: 200_000_000n, ...status },
    ttl: { latestLedger: 5_900_000, instanceLiveUntil: 6_018_006, escrowLiveUntil: 6_018_006 },
  });
}

/** A protected 20 USDC trade, accepted by both, created and funded on its escrow, with both traders talking in it. */
async function fundedProtectedTradeWithChat(): Promise<string> {
  const [usdc] = await f.db.insert(listings).values({ ...f.listing, id: undefined, asset: "USDC" }).returning();
  const { id } = await f.as(f.taker).trade.open({ listingId: usdc.id, amount: "20", mode: "protected", acceptanceVersion: ACCEPTANCE_VERSION });
  await f.as(f.owner).trade.agree({ tradeId: id, acceptanceVersion: ACCEPTANCE_VERSION });
  // prepareCreate stores these two before anything is signed (FIXES F-02); its Trustless Work answer is escrow.test.ts's.
  await f.db.update(trades).set({ escrowAdmin: ADMIN, escrowContractId: ESCROW }).where(eq(trades.id, id));
  chainShows({ balanceStroops: 0n });
  vi.mocked(verifyEscrowTx).mockResolvedValueOnce({ createdAt: at(), signer: ADMIN, contractId: ESCROW, transfers: [] });
  await f.as(f.owner).escrow.recordCreate({ tradeId: id, txHash: "1".repeat(64) });
  vi.mocked(verifyEscrowTx).mockResolvedValueOnce({ createdAt: at(), signer: f.owner, contractId: ESCROW, transfers: [{ from: f.owner, to: ESCROW, amountStroops: 200_000_000n }] });
  await f.as(f.owner).escrow.recordFund({ tradeId: id, txHash: "2".repeat(64) });
  await f.as(f.taker).chat.send({ tradeId: id, body: "Meet at the station?" });
  await f.as(f.owner).chat.send({ tradeId: id, body: "See you at 3" });
  await f.as(f.taker).chat.send({ tradeId: id, body: "On my way" });
  return id;
}

/** The buyer disputes on chain, and both traders answer with a note. */
async function disputeWithNotes(tradeId: string) {
  vi.mocked(verifyEscrowTx).mockResolvedValueOnce({ createdAt: at(), signer: f.taker, contractId: ESCROW, transfers: [] });
  await f.as(f.taker).escrow.recordDispute({ tradeId, txHash: "3".repeat(64) });
  await f.as(f.owner).escrow.answer({ tradeId, cashHandedOver: true, note: "Paid in full at the station." });
  await f.as(f.taker).escrow.answer({ tradeId, cashHandedOver: false, note: "Short by 100 TRY." });
}

/** The arbiter's resolution, found on chain by trade.sync, paying `to`. */
async function resolvedTo(tradeId: string, to: string) {
  chainShows({ resolved: true, balanceStroops: 0n });
  vi.mocked(findEscrowTx).mockImplementation(async (account, _c, fn) => (account === ARBITER_ACCOUNT && fn === "resolve_dispute" ? "4".repeat(64) : null));
  vi.mocked(verifyEscrowTx).mockResolvedValueOnce({ createdAt: at(), signer: ARBITER_ACCOUNT, contractId: ESCROW, transfers: [], payout: { to, amountStroops: 200_000_000n } });
  await f.as(f.taker).trade.sync({ tradeId });
}

async function notes(tradeId: string) {
  return (await f.db.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, tradeId))).map((a) => [a.role, a.cashHandedOver, a.note]).sort();
}

const protectedTerminals: [string, (tradeId: string) => Promise<void>][] = [
  [
    "released",
    async (id) => {
      vi.mocked(verifyEscrowTx).mockResolvedValueOnce({ createdAt: at(), signer: f.owner, contractId: ESCROW, transfers: [] });
      await f.as(f.taker).escrow.recordRelease({ tradeId: id, txHash: "5".repeat(64) });
    },
  ],
  [
    "resolved_buyer",
    async (id) => {
      await disputeWithNotes(id);
      await resolvedTo(id, f.taker);
    },
  ],
  [
    "resolved_seller",
    async (id) => {
      await disputeWithNotes(id);
      await resolvedTo(id, f.owner);
    },
  ],
];

describe("coordination-purge-on-terminal: protected trades", () => {
  it.each(protectedTerminals)("deletes every chat row and every dispute note, keeping the answers, when the trade is %s", async (state, finish) => {
    const tradeId = await fundedProtectedTradeWithChat();
    const bystander = await tradeWithChat();
    expect(await chatCount(tradeId)).toBe(3);

    await finish(tradeId);

    expect((await f.as(f.taker).trade.byId({ id: tradeId })).state).toBe(state);
    expect(await chatCount(tradeId)).toBe(0);
    expect(await chatCount(bystander)).toBe(3);
    // Every note is gone; each yes/no answer stays in the timeline.
    expect((await notes(tradeId)).every(([, , note]) => note === null)).toBe(true);
    if (state !== "released") {
      expect(await notes(tradeId)).toEqual([
        ["buyer", false, null],
        ["seller", true, null],
      ]);
    }
  });

  it("keeps the chat and the notes of a funded, disputed protected trade", async () => {
    const tradeId = await fundedProtectedTradeWithChat();
    await disputeWithNotes(tradeId);
    // The chain shows the dispute open: sync changes nothing.
    chainShows({ disputed: true });
    await f.as(f.taker).trade.sync({ tradeId });
    expect((await f.as(f.taker).trade.byId({ id: tradeId })).state).toBe("funded");
    expect(await chatCount(tradeId)).toBe(3);
    expect(await notes(tradeId)).toEqual([
      ["buyer", false, "Short by 100 TRY."],
      ["seller", true, "Paid in full at the station."],
    ]);
  });
});
