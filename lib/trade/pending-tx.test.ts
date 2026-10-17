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
const trade = { state: "agreed", lockTx: null, claimTx: null, reclaimTx: null };

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
});
