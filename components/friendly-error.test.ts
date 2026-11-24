import { describe, expect, it } from "vitest";

import { TradeStateMachine } from "@/lib/trade/state-machine";

import { SESSION_ENDED, friendlyError } from "./friendly-error";

/** The message the server sends for a refused transition, taken from the real state machine. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("friendlyError (Q-22, Q-25)", () => {
  const agreed = TradeStateMachine.open("buyer").apply({ type: "agree", by: "seller" });

  it("turns a refused transition into a plain sentence", () => {
    const twice = refusal(() => agreed.apply({ type: "agree", by: "seller" }));
    expect(twice).toMatch(/^Cannot agree a agreed trade/);
    expect(friendlyError({ message: twice })).toBe("This trade was already agreed.");

    const cancelled = agreed.apply({ type: "cancel", by: "buyer" });
    expect(friendlyError({ message: refusal(() => cancelled.apply({ type: "cancel", by: "seller" })) })).toBe(
      "This trade was already cancelled.",
    );
    const own = refusal(() => TradeStateMachine.open("buyer").apply({ type: "agree", by: "buyer" }));
    expect(friendlyError({ message: own })).toMatch(/your peer is the one who agrees/);
  });

  it("turns each refused protected transition into a plain sentence", () => {
    const at = new Date("2026-12-01T10:00:00Z");
    const agreedP = TradeStateMachine.open("buyer", "protected").apply({ type: "agree", by: "seller", acceptedAt: at });
    const createdP = agreedP.apply({ type: "escrowCreate", by: "seller", contractId: "C".repeat(56), txHash: "c".repeat(64) });
    const fundedP = createdP.apply({ type: "fund", by: "seller", txHash: "f".repeat(64), fundedAt: at });
    const disputedP = fundedP.apply({ type: "escrowDispute", by: "buyer", txHash: "d".repeat(64), disputedAt: at });
    const releasedP = fundedP.apply({ type: "release", by: "seller", txHash: "r".repeat(64) });
    const plain = (run: () => unknown) => friendlyError({ message: refusal(run) });

    expect(plain(() => fundedP.apply({ type: "cancel", by: "buyer" }))).toBe(
      "This trade is funded, so it can't be cancelled. The seller releases the escrow, or a dispute goes to the arbiter.",
    );
    expect(plain(() => createdP.apply({ type: "escrowCreate", by: "seller", contractId: "C".repeat(56), txHash: "c".repeat(64) }))).toBe(
      "The escrow was already created.",
    );
    expect(plain(() => fundedP.apply({ type: "fund", by: "seller", txHash: "f".repeat(64), fundedAt: at }))).toBe(
      "The escrow is already funded.",
    );
    expect(plain(() => disputedP.apply({ type: "release", by: "seller", txHash: "r".repeat(64) }))).toBe(
      "A dispute is open on this escrow, so only the arbiter can settle it.",
    );
    expect(plain(() => disputedP.apply({ type: "escrowDispute", by: "seller", txHash: "d".repeat(64), disputedAt: at }))).toBe(
      "A dispute is already open on this escrow.",
    );
    expect(plain(() => fundedP.apply({ type: "resolve", by: "arbiter", outcome: "buyer", txHash: "e".repeat(64), resolvedAt: at }))).toBe(
      "This escrow has no open dispute.",
    );
    expect(plain(() => releasedP.apply({ type: "cancel", by: "buyer" }))).toBe("This trade has already ended.");
    expect(plain(() => agreedP.apply({ type: "lock", by: "seller", balanceId: "b", txHash: "l".repeat(64) }))).toBe(
      "This is a protected trade: it settles through its escrow, not a lock.",
    );
    expect(plain(() => agreed.apply({ type: "escrowCreate", by: "seller", contractId: "C".repeat(56), txHash: "c".repeat(64) }))).toBe(
      "This isn't a protected trade.",
    );
  });

  it("says the session ended instead of UNAUTHORIZED", () => {
    expect(friendlyError({ message: "UNAUTHORIZED", data: { code: "UNAUTHORIZED" } })).toBe(SESSION_ENDED);
  });

  it("passes other messages through", () => {
    expect(friendlyError({ message: "Trade not found", data: { code: "NOT_FOUND" } })).toBe("Trade not found");
  });
});
