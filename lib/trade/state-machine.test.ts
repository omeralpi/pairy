import { describe, expect, it } from "vitest";

import { TradeStateMachine, TradeTransitionError } from "./state-machine";

const lock = { type: "lock", by: "seller", balanceId: "00ab", txHash: "lockhash" } as const;

function lockedTrade() {
  return TradeStateMachine.open("buyer")
    .apply({ type: "agree", by: "seller" })
    .apply(lock);
}

describe("TradeStateMachine", () => {
  it("walks listed → agreed → locked → claimed", () => {
    const m = lockedTrade().apply({ type: "claim", by: "buyer", txHash: "claimhash" });
    expect(m.state).toBe("claimed");
    expect(m.isTerminal).toBe(true);
    expect(m.snapshot).toMatchObject({ balanceId: "00ab", lockTx: "lockhash", claimTx: "claimhash" });
  });

  it("walks locked → reclaimed for the seller", () => {
    const m = lockedTrade().apply({ type: "reclaim", by: "seller", txHash: "rehash" });
    expect(m.state).toBe("reclaimed");
    expect(m.snapshot.reclaimTx).toBe("rehash");
  });

  it("does not let the opener agree to their own trade", () => {
    expect(TradeStateMachine.open("buyer").can({ type: "agree", by: "buyer" })).toBe(false);
  });

  it("only lets the seller lock and only the buyer claim", () => {
    const agreed = TradeStateMachine.open("seller").apply({ type: "agree", by: "buyer" });
    expect(agreed.can({ ...lock, by: "buyer" })).toBe(false);
    expect(lockedTrade().can({ type: "claim", by: "seller", txHash: "x" })).toBe(false);
    expect(lockedTrade().can({ type: "reclaim", by: "buyer", txHash: "x" })).toBe(false);
  });

  it("cannot be cancelled once locked", () => {
    expect(() => lockedTrade().apply({ type: "cancel", by: "seller" })).toThrow(TradeTransitionError);
    expect(TradeStateMachine.open("buyer").apply({ type: "cancel", by: "buyer" }).state).toBe("cancelled");
  });

  it("records a dispute flag without changing state or acting on it", () => {
    const m = lockedTrade().apply({ type: "flagDispute", by: "buyer" });
    expect(m.state).toBe("locked");
    expect(m.snapshot.disputed).toBe(true);
    // Claim still works: the flag is a hook for Phase 2, not a freeze.
    expect(m.apply({ type: "claim", by: "buyer", txHash: "c" }).state).toBe("claimed");
  });

  it("rejects every event on a terminal trade", () => {
    const done = lockedTrade().apply({ type: "claim", by: "buyer", txHash: "c" });
    for (const e of [
      { type: "agree", by: "buyer" },
      lock,
      { type: "claim", by: "buyer", txHash: "c" },
      { type: "reclaim", by: "seller", txHash: "r" },
      { type: "cancel", by: "seller" },
      { type: "flagDispute", by: "buyer" },
    ] as const) {
      expect(done.can(e)).toBe(false);
    }
  });

  it("never mutates the original snapshot", () => {
    const listed = TradeStateMachine.open("buyer");
    listed.apply({ type: "agree", by: "seller" });
    expect(listed.state).toBe("listed");
  });
});
