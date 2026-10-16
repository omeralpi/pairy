import { beforeEach, describe, expect, it, vi } from "vitest";

import { tradeFixture } from "@/lib/trade/test-helpers";

vi.mock("@/lib/stellar/verify", () => ({ verifyLockTx: vi.fn(), verifyClaimTx: vi.fn(), hasLiveLock: vi.fn(async () => false) }));

let f: Awaited<ReturnType<typeof tradeFixture>>;
let tradeId: string;

beforeEach(async () => {
  f = await tradeFixture();
  tradeId = (await f.as(f.taker).trade.open({ listingId: f.listing.id, amount: "20" })).id;
});

describe("chat", () => {
  it("lets both participants send and read, oldest first", async () => {
    await f.as(f.taker).chat.send({ tradeId, body: "  At the cafe by the tram stop?  " });
    await f.as(f.owner).chat.send({ tradeId, body: "Yes, 15:00" });
    const list = await f.as(f.owner).chat.list({ tradeId });
    expect(list.map((m) => [m.author, m.body])).toEqual([
      [f.taker, "At the cafe by the tram stop?"],
      [f.owner, "Yes, 15:00"],
    ]);
  });

  it("returns only messages after `after`", async () => {
    const first = await f.as(f.taker).chat.send({ tradeId, body: "one" });
    await new Promise((r) => setTimeout(r, 5));
    await f.as(f.owner).chat.send({ tradeId, body: "two" });
    const newer = await f.as(f.taker).chat.list({ tradeId, after: first.createdAt });
    expect(newer.map((m) => m.body)).toEqual(["two"]);
  });

  it("enforces the 1000-character limit and rejects empty messages", async () => {
    await expect(f.as(f.taker).chat.send({ tradeId, body: "x".repeat(1001) })).rejects.toThrow();
    await expect(f.as(f.taker).chat.send({ tradeId, body: "   " })).rejects.toThrow();
    expect((await f.as(f.taker).chat.send({ tradeId, body: "x".repeat(1000) })).body).toHaveLength(1000);
  });

  it("is closed to non-participants", async () => {
    await f.as(f.taker).chat.send({ tradeId, body: "hi" });
    await expect(f.as(f.stranger).chat.list({ tradeId })).rejects.toThrow(/Trade not found/);
    await expect(f.as(f.stranger).chat.send({ tradeId, body: "hi" })).rejects.toThrow(/Trade not found/);
    await expect(f.as(null).chat.list({ tradeId })).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("rejects sending on a terminal trade", async () => {
    await f.as(f.owner).trade.cancel({ tradeId });
    await expect(f.as(f.taker).chat.send({ tradeId, body: "still there?" })).rejects.toThrow(/chat is closed/);
    expect(await f.as(f.taker).chat.list({ tradeId })).toEqual([]);
  });
});
