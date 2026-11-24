import { describe, expect, it } from "vitest";

import { clearPendingTx, pendingTxAction, readPendingTx, savePendingTx } from "./pending-tx";

class MemoryStorage {
  items = new Map<string, string>();
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, v);
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
}

const blocked = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("SecurityError");
  },
} as unknown as Storage;

const HASH = "ab".repeat(32);
const trade = { state: "agreed", lockTx: null, claimTx: null, reclaimTx: null, createTx: null, fundTx: null, releaseTx: null };

describe("pending tx store (Q-1, Q-2)", () => {
  it("keeps a signed hash per trade until it is cleared", () => {
    const s = new MemoryStorage() as unknown as Storage;
    savePendingTx("t1", { kind: "lock", hash: HASH }, s, 1000);
    expect(readPendingTx("t1", s)).toEqual({ kind: "lock", hash: HASH, savedAt: 1000 });
    expect(readPendingTx("t2", s)).toBeNull();
    clearPendingTx("t1", s);
    expect(readPendingTx("t1", s)).toBeNull();
  });

  it("ignores junk and survives blocked storage", () => {
    const s = new MemoryStorage();
    s.setItem("pairy:pending-tx:t1", '{"kind":"lock","hash":"nope","savedAt":1}');
    expect(readPendingTx("t1", s as unknown as Storage)).toBeNull();
    s.setItem("pairy:pending-tx:t1", "{not json");
    expect(readPendingTx("t1", s as unknown as Storage)).toBeNull();
    expect(() => savePendingTx("t1", { kind: "lock", hash: HASH }, blocked)).not.toThrow();
    expect(readPendingTx("t1", blocked)).toBeNull();
    expect(() => clearPendingTx("t1", blocked)).not.toThrow();
  });

  it("reports a lock only while none is recorded, and a claim only while locked", () => {
    const lock = { kind: "lock" as const, hash: HASH, savedAt: 0 };
    const claim = { kind: "claim" as const, hash: HASH, savedAt: 0 };
    expect(pendingTxAction(trade, lock)).toBe("record");
    expect(pendingTxAction({ ...trade, state: "cancelled" }, lock)).toBe("record");
    expect(pendingTxAction({ ...trade, state: "locked", lockTx: HASH }, lock)).toBe("clear");
    expect(pendingTxAction({ ...trade, state: "locked", lockTx: HASH }, claim)).toBe("record");
    expect(pendingTxAction({ ...trade, state: "claimed", lockTx: HASH, claimTx: HASH }, claim)).toBe("clear");
  });

  it("keeps the hash of a protected trade's escrow creation, fund or release too (WP-34)", () => {
    const s = new MemoryStorage() as unknown as Storage;
    for (const kind of ["create", "fund", "release"] as const) {
      savePendingTx("t1", { kind, hash: HASH }, s, 1000);
      expect(readPendingTx("t1", s)).toEqual({ kind, hash: HASH, savedAt: 1000 });
    }
  });

  it("reports an escrow creation only while the agreed trade has none recorded", () => {
    const create = { kind: "create" as const, hash: HASH, savedAt: 0 };
    expect(pendingTxAction(trade, create)).toBe("record");
    expect(pendingTxAction({ ...trade, state: "escrow_created", createTx: HASH }, create)).toBe("clear");
    // recordCreate takes a creation only for an agreed trade; an empty escrow left behind holds nothing.
    expect(pendingTxAction({ ...trade, state: "cancelled" }, create)).toBe("clear");
  });

  it("reports a fund while the created escrow has none recorded, after a cancel too (chain wins)", () => {
    const fund = { kind: "fund" as const, hash: HASH, savedAt: 0 };
    const created = { ...trade, state: "escrow_created", createTx: HASH };
    expect(pendingTxAction(created, fund)).toBe("record");
    expect(pendingTxAction({ ...created, state: "cancelled" }, fund)).toBe("record");
    expect(pendingTxAction({ ...created, state: "funded", fundTx: HASH }, fund)).toBe("clear");
    expect(pendingTxAction({ ...trade, state: "cancelled" }, fund)).toBe("clear");
  });

  it("reports a release only while the escrow is funded and not yet released", () => {
    const release = { kind: "release" as const, hash: HASH, savedAt: 0 };
    const funded = { ...trade, state: "funded", createTx: HASH, fundTx: HASH };
    expect(pendingTxAction(funded, release)).toBe("record");
    expect(pendingTxAction({ ...funded, state: "released", releaseTx: HASH }, release)).toBe("clear");
  });
});
