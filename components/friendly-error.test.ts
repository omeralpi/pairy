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

  it("says the session ended instead of UNAUTHORIZED", () => {
    expect(friendlyError({ message: "UNAUTHORIZED", data: { code: "UNAUTHORIZED" } })).toBe(SESSION_ENDED);
  });

  it("passes other messages through", () => {
    expect(friendlyError({ message: "Trade not found", data: { code: "NOT_FOUND" } })).toBe("Trade not found");
  });
});
