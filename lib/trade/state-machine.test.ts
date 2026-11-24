import { describe, expect, it } from "vitest";

import {
  TERMINAL_STATES,
  TRADE_MODES,
  TRADE_STATES,
  TradeStateMachine,
  TradeTransitionError,
  type TradeMode,
  type TradeState,
} from "./state-machine";

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

  it("records a lock found on the ledger even if the app thought the trade was cancelled", () => {
    // The chain outranks the app: a lock that landed while the buyer cancelled is real.
    const cancelled = TradeStateMachine.open("buyer")
      .apply({ type: "agree", by: "seller" })
      .apply({ type: "cancel", by: "buyer" });
    expect(cancelled.can(lock)).toBe(false);
    const m = cancelled.apply({ ...lock, reconcile: true });
    expect(m.state).toBe("locked");
    expect(m.snapshot.lockTx).toBe("lockhash");
  });

  it("records a reconciled lock from listed, but never from a settled trade", () => {
    expect(TradeStateMachine.open("buyer").apply({ ...lock, reconcile: true }).state).toBe("locked");
    const claimed = lockedTrade().apply({ type: "claim", by: "buyer", txHash: "c" });
    expect(claimed.can({ ...lock, reconcile: true })).toBe(false);
    expect(lockedTrade().can({ ...lock, by: "buyer", reconcile: true })).toBe(false);
  });

  it("lets the system expire an idle trade before the lock, never after", () => {
    const expire = { type: "expire", by: "system" } as const;
    expect(TradeStateMachine.open("buyer").apply(expire).state).toBe("cancelled");
    expect(TradeStateMachine.open("buyer").apply({ type: "agree", by: "seller" }).apply(expire).state).toBe("cancelled");
    expect(lockedTrade().can(expire)).toBe(false);
  });

  it("closes any unfinished trade after a testnet reset, but never a settled one", () => {
    const reset = { type: "reset", by: "system" } as const;
    expect(TradeStateMachine.open("buyer").apply(reset).state).toBe("cancelled");
    const wiped = lockedTrade().apply(reset);
    expect(wiped.state).toBe("cancelled");
    expect(wiped.snapshot.lockTx).toBe("lockhash"); // the record of the lock stays
    expect(lockedTrade().apply({ type: "claim", by: "buyer", txHash: "c" }).can(reset)).toBe(false);
  });

  it("never mutates the original snapshot", () => {
    const listed = TradeStateMachine.open("buyer");
    listed.apply({ type: "agree", by: "seller" });
    expect(listed.state).toBe("listed");
  });
});

// Protected mode (D2 §4): the same machine, with escrow states recorded only
// from the chain. Each mode refuses the other mode's events.
const ESCROW = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const at = new Date("2026-11-24T10:00:00Z");
const escrowCreate = { type: "escrowCreate", by: "seller", contractId: ESCROW, txHash: "createhash" } as const;
const fund = { type: "fund", by: "seller", txHash: "fundhash", fundedAt: at } as const;
const release = { type: "release", by: "seller", txHash: "releasehash" } as const;
const escrowDispute = { type: "escrowDispute", by: "buyer", txHash: "disputehash", disputedAt: at } as const;
const resolve = { type: "resolve", by: "arbiter", outcome: "buyer", txHash: "resolvehash", resolvedAt: at } as const;

/** Opened by the buyer, so the seller agrees, accepting the protected-trade terms. */
function fundedTrade() {
  return TradeStateMachine.open("buyer", "protected")
    .apply({ type: "agree", by: "seller", acceptedAt: at })
    .apply(escrowCreate)
    .apply(fund);
}

describe("TradeStateMachine, mode × state × event", () => {
  // One valid actor per event; actors are checked separately below.
  const events = {
    agree: { type: "agree", by: "seller", acceptedAt: at },
    lock,
    claim: { type: "claim", by: "buyer", txHash: "c" },
    reclaim: { type: "reclaim", by: "seller", txHash: "r" },
    cancel: { type: "cancel", by: "buyer" },
    expire: { type: "expire", by: "system" },
    reset: { type: "reset", by: "system" },
    flagDispute: { type: "flagDispute", by: "buyer" },
    escrowCreate,
    fund,
    release,
    escrowDispute,
    resolve,
  } as const;
  type Row = { state: TradeState; disputed?: boolean; allowed: (keyof typeof events)[] };

  // Every state each mode can hold (trades_mode_states), and the events allowed there, in `events` order.
  const table: Record<TradeMode, Row[]> = {
    claimable: [
      { state: "listed", allowed: ["agree", "cancel", "expire", "reset", "flagDispute"] },
      { state: "agreed", allowed: ["lock", "cancel", "expire", "reset", "flagDispute"] },
      { state: "locked", allowed: ["claim", "reclaim", "reset", "flagDispute"] },
      { state: "claimed", allowed: [] },
      { state: "reclaimed", allowed: [] },
      { state: "cancelled", allowed: [] },
    ],
    protected: [
      { state: "listed", allowed: ["agree", "cancel", "expire", "reset"] },
      { state: "agreed", allowed: ["cancel", "expire", "reset", "escrowCreate"] },
      { state: "escrow_created", allowed: ["cancel", "expire", "reset", "fund"] },
      { state: "funded", allowed: ["reset", "release", "escrowDispute"] },
      { state: "funded", disputed: true, allowed: ["reset", "resolve"] },
      { state: "released", allowed: [] },
      { state: "resolved_buyer", disputed: true, allowed: [] },
      { state: "resolved_seller", disputed: true, allowed: [] },
      { state: "cancelled", allowed: [] },
    ],
  };

  for (const mode of TRADE_MODES) {
    for (const { state, disputed = false, allowed } of table[mode]) {
      it(`${mode} ${state}${disputed ? " (disputed)" : ""} allows exactly ${allowed.join(", ") || "nothing"}`, () => {
        const m = new TradeStateMachine({ ...TradeStateMachine.open("buyer", mode).snapshot, state, disputed });
        const got = (Object.keys(events) as (keyof typeof events)[]).filter((e) => m.can(events[e]));
        expect(got).toEqual(allowed);
      });
    }
  }

  it("covers every state of both modes", () => {
    const covered = new Set([...table.claimable, ...table.protected].map((r) => r.state));
    expect([...covered].sort()).toEqual([...TRADE_STATES].sort());
  });
});

describe("TradeStateMachine, protected mode", () => {
  it("opens claimable unless told otherwise", () => {
    expect(TradeStateMachine.open("buyer").snapshot.mode).toBe("claimable");
    expect(TradeStateMachine.open("seller", "protected").snapshot).toMatchObject({
      mode: "protected",
      state: "listed",
      escrowContractId: null,
      createTx: null,
      fundTx: null,
      releaseTx: null,
      disputeTx: null,
      resolveTx: null,
    });
  });

  it("walks listed → agreed → escrow_created → funded → released, recording each transaction", () => {
    const funded = fundedTrade();
    expect(funded.snapshot).toMatchObject({ state: "funded", escrowContractId: ESCROW, createTx: "createhash", fundTx: "fundhash" });
    const m = funded.apply(release);
    expect(m.state).toBe("released");
    expect(m.isTerminal).toBe(true);
    expect(m.snapshot.releaseTx).toBe("releasehash");
  });

  it("marks a dispute from the chain without changing state, then resolves to either side", () => {
    const disputed = fundedTrade().apply(escrowDispute);
    expect(disputed.snapshot).toMatchObject({ state: "funded", disputed: true, disputeTx: "disputehash" });
    const toBuyer = disputed.apply(resolve);
    expect(toBuyer.snapshot).toMatchObject({ state: "resolved_buyer", resolveTx: "resolvehash" });
    expect(toBuyer.isTerminal).toBe(true);
    const toSeller = disputed.apply({ ...resolve, outcome: "seller" });
    expect(toSeller.state).toBe("resolved_seller");
    expect(toSeller.isTerminal).toBe(true);
  });

  it("refuses a release while disputed and a resolve while not disputed", () => {
    expect(() => fundedTrade().apply(escrowDispute).apply(release)).toThrow(
      "Cannot release a funded trade: a disputed escrow is settled by the arbiter",
    );
    expect(() => fundedTrade().apply(resolve)).toThrow("Cannot resolve a funded trade: only a disputed escrow is resolved by the arbiter");
    expect(fundedTrade().apply(escrowDispute).can({ ...escrowDispute, by: "seller" })).toBe(false);
  });

  it("lets either party dispute, and only the seller create, fund and release", () => {
    expect(fundedTrade().can({ ...escrowDispute, by: "seller" })).toBe(true);
    expect(fundedTrade().can({ ...escrowDispute, by: "buyer" })).toBe(true);
    const agreed = TradeStateMachine.open("buyer", "protected").apply({ type: "agree", by: "seller", acceptedAt: at });
    expect(agreed.can({ ...escrowCreate, by: "buyer" })).toBe(false);
    expect(agreed.apply(escrowCreate).can({ ...fund, by: "buyer" })).toBe(false);
    expect(fundedTrade().can({ ...release, by: "buyer" })).toBe(false);
  });

  it("refuses to agree to a protected trade without accepting its terms", () => {
    const listed = TradeStateMachine.open("buyer", "protected");
    expect(() => listed.apply({ type: "agree", by: "seller" })).toThrow(
      "Cannot agree a listed trade: a protected trade is agreed only by accepting its terms",
    );
    expect(listed.apply({ type: "agree", by: "seller", acceptedAt: at }).state).toBe("agreed");
    // A claimable trade has no terms to accept.
    expect(TradeStateMachine.open("buyer").apply({ type: "agree", by: "seller" }).state).toBe("agreed");
  });

  it("records the escrow prepared for the trade, never a different one (F-02)", () => {
    const agreed = TradeStateMachine.open("buyer", "protected").apply({ type: "agree", by: "seller", acceptedAt: at });
    // prepareCreate stores the contract id while the trade is still agreed.
    const prepared = new TradeStateMachine({ ...agreed.snapshot, escrowContractId: ESCROW });
    expect(prepared.apply(escrowCreate).snapshot.escrowContractId).toBe(ESCROW);
    expect(() => prepared.apply({ ...escrowCreate, contractId: "C" + "B".repeat(55) })).toThrow(
      "Cannot escrowCreate a agreed trade: the escrow is not the one prepared for this trade",
    );
  });

  it("records a fund found on the chain after a cancel only when the escrow was recorded (chain wins)", () => {
    const created = TradeStateMachine.open("buyer", "protected")
      .apply({ type: "agree", by: "seller", acceptedAt: at })
      .apply(escrowCreate);
    const cancelled = created.apply({ type: "cancel", by: "buyer" });
    expect(cancelled.can(fund)).toBe(false);
    const m = cancelled.apply({ ...fund, reconcile: true });
    expect(m.snapshot).toMatchObject({ state: "funded", fundTx: "fundhash", createTx: "createhash" });

    // Cancelled before any escrow was recorded: there is nothing to fund.
    const bare = TradeStateMachine.open("buyer", "protected").apply({ type: "cancel", by: "buyer" });
    expect(bare.can({ ...fund, reconcile: true })).toBe(false);
    // reconcile never skips the escrow's creation.
    const agreed = TradeStateMachine.open("buyer", "protected").apply({ type: "agree", by: "seller", acceptedAt: at });
    expect(agreed.can({ ...fund, reconcile: true })).toBe(false);
  });

  it("never cancels or expires a funded trade", () => {
    expect(() => fundedTrade().apply({ type: "cancel", by: "seller" })).toThrow(
      "Cannot cancel a funded trade: once funded, the only ways out are the release and the arbiter",
    );
    expect(fundedTrade().can({ type: "expire", by: "system" })).toBe(false);
  });

  it("closes a funded trade after a testnet reset, keeping the escrow record", () => {
    const wiped = fundedTrade().apply({ type: "reset", by: "system" });
    expect(wiped.snapshot).toMatchObject({ state: "cancelled", escrowContractId: ESCROW, fundTx: "fundhash" });
  });

  it("refuses each mode's events in the other mode", () => {
    expect(() => TradeStateMachine.open("buyer").apply({ type: "agree", by: "seller" }).apply(escrowCreate)).toThrow(
      "Cannot escrowCreate a agreed trade: only a protected trade has an escrow",
    );
    expect(() => fundedTrade().apply({ type: "flagDispute", by: "buyer" })).toThrow(
      "Cannot flagDispute a funded trade: a protected trade settles through its escrow",
    );
    const agreed = TradeStateMachine.open("buyer", "protected").apply({ type: "agree", by: "seller", acceptedAt: at });
    expect(agreed.can(lock)).toBe(false);
    expect(agreed.can({ ...lock, reconcile: true })).toBe(false);
  });

  it("treats released and both resolutions as terminal", () => {
    expect(TERMINAL_STATES).toEqual(["claimed", "reclaimed", "cancelled", "released", "resolved_buyer", "resolved_seller"]);
  });
});
