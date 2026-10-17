// SOW D2/D3 evidence: per-deal chat is purged server-side the moment a trade
// reaches a terminal state (claimed, reclaimed or cancelled). Each case drives
// the trade through the real tRPC router; only the Horizon read-back in
// verify.ts is mocked.

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { chatMessages } from "@/lib/db/schema";
import { verifyClaimTx, verifyLockTx } from "@/lib/stellar/verify";
import { TX, tradeFixture } from "@/lib/trade/test-helpers";

vi.mock("@/lib/stellar/verify", async (orig) => ({ ...(await orig<typeof import("@/lib/stellar/verify")>()), verifyLockTx: vi.fn(), verifyClaimTx: vi.fn(), findLockTx: vi.fn(async () => null), findClaimTx: vi.fn(async () => null) }));

let f: Awaited<ReturnType<typeof tradeFixture>>;

beforeEach(async () => {
  f = await tradeFixture();
});

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
