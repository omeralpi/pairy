import { describe, expect, it } from "vitest";

import { TRADE_STATES, type TradeRole, type TradeState } from "@/lib/trade/state-machine";

import { STATE_LABEL, disputeBadge, shortWhen, statusSentence } from "./format";

// A protected trade of 10 USDC, seen from each side.
const base = {
  state: "listed" as TradeState,
  role: "seller" as TradeRole,
  openedBy: "buyer" as TradeRole,
  asset: "USDC",
  amount: "10.0000000",
  mode: "protected" as const,
  disputed: false,
  lockTx: null as string | null,
  createTx: null as string | null,
  fundTx: null as string | null,
  disputeRecordedAt: null as Date | null,
  disputedAt: null as Date | null,
};
const protectedTrade = (t: Partial<typeof base>) => ({ ...base, ...t });
/** A protected trade never holds a lock, so it never reaches these three. */
const PROTECTED_STATES = TRADE_STATES.filter((s) => !["locked", "claimed", "reclaimed"].includes(s));
const seller = (t: Partial<typeof base>) => statusSentence(protectedTrade({ ...t, role: "seller" }));
const buyer = (t: Partial<typeof base>) => statusSentence(protectedTrade({ ...t, role: "buyer" }));

describe("statusSentence for a protected trade", () => {
  it("has a sentence of its own for every state, never the bare label", () => {
    for (const state of PROTECTED_STATES) {
      for (const role of ["seller", "buyer"] as const) {
        const s = statusSentence(protectedTrade({ state, role, createTx: "c", fundTx: "f" }));
        expect(s, `${state} as ${role}`).not.toBe(`${STATE_LABEL[state]}.`);
        expect(s, `${state} as ${role}`).toMatch(/\.$/);
      }
    }
  });

  it("waits for the terms to be accepted while listed", () => {
    expect(seller({ openedBy: "buyer" })).toBe("Protected trade. Waiting for you to accept the terms.");
    expect(buyer({ openedBy: "buyer" })).toBe("Protected trade. Waiting for the seller to accept the terms.");
    expect(seller({ openedBy: "seller" })).toBe("Protected trade. Waiting for the buyer to accept the terms.");
  });

  it("never tells either side to lock once agreed", () => {
    expect(seller({ state: "agreed" })).toBe("Agreed. Create the escrow when you're ready.");
    expect(buyer({ state: "agreed" })).toBe("Agreed. Waiting for the seller to create the escrow.");
  });

  it("says who funds the escrow once it exists", () => {
    expect(seller({ state: "escrow_created", createTx: "c" })).toBe("The escrow exists. Check its terms, then fund it.");
    expect(buyer({ state: "escrow_created", createTx: "c" })).toBe("The escrow exists. Waiting for the seller to fund it.");
  });

  it("ties the cash to the release once funded, and to the arbiter once disputed", () => {
    expect(seller({ state: "funded", createTx: "c", fundTx: "f" })).toBe("Funded. Release only when you hold the cash.");
    expect(buyer({ state: "funded", createTx: "c", fundTx: "f" })).toBe(
      "Funded. Hand over the cash only when the release shows here.",
    );
    for (const role of [seller, buyer]) {
      expect(role({ state: "funded", createTx: "c", fundTx: "f", disputed: true })).toBe(
        "Dispute open. Only the arbiter can settle this escrow now.",
      );
    }
  });

  it("names what the buyer received after the 0.3% fee on a release", () => {
    expect(buyer({ state: "released", createTx: "c", fundTx: "f" })).toBe("Settled. You received 9.97 USDC.");
    expect(seller({ state: "released", createTx: "c", fundTx: "f" })).toBe("Settled. The buyer received 9.97 USDC.");
    expect(seller({ state: "released", amount: "100.0000000" })).toBe("Settled. The buyer received 99.7 USDC.");
    expect(seller({ state: "released", amount: "12.3456789" })).toBe("Settled. The buyer received 12.3086419 USDC.");
  });

  it("names the arbiter's outcome from the viewer's side", () => {
    expect(buyer({ state: "resolved_buyer" })).toBe("Settled by the arbiter: all to you, less 0.3%.");
    expect(seller({ state: "resolved_buyer" })).toBe("Settled by the arbiter: all to the buyer, less 0.3%.");
    expect(seller({ state: "resolved_seller" })).toBe("Settled by the arbiter: all to you, less 0.3%.");
    expect(buyer({ state: "resolved_seller" })).toBe("Settled by the arbiter: all to the seller, less 0.3%.");
  });

  it("tells a cancelled protected trade apart by how far the escrow got", () => {
    expect(seller({ state: "cancelled" })).toBe("Cancelled. No escrow was created.");
    expect(seller({ state: "cancelled", createTx: "c" })).toBe("Cancelled. The escrow was never funded.");
    // Only a testnet reset cancels a funded protected trade.
    expect(seller({ state: "cancelled", createTx: "c", fundTx: "f" })).toBe(
      "Closed: Stellar testnet was reset, so this escrow no longer exists.",
    );
  });

  it("never mentions a lock or a claim in protected mode", () => {
    for (const state of PROTECTED_STATES) {
      for (const role of ["seller", "buyer"] as const) {
        for (const disputed of [false, true]) {
          const s = statusSentence(protectedTrade({ state, role, disputed, createTx: "c", fundTx: "f" }));
          expect(s, `${state} as ${role}`).not.toMatch(/lock|claim/i);
        }
      }
    }
  });

  it("leaves the claimable sentences as they were", () => {
    const claimable = { ...base, mode: "claimable" as const, asset: "XLM" };
    expect(statusSentence({ ...claimable, state: "agreed" })).toBe("Agreed. Lock when you're both at the meeting point.");
    expect(statusSentence({ ...claimable, state: "listed", role: "buyer" })).toBe("Waiting for the seller to agree.");
    expect(statusSentence({ ...claimable, state: "claimed", role: "buyer" })).toBe("Settled. The XLM is in your wallet.");
    expect(statusSentence({ ...claimable, state: "cancelled" })).toBe("Cancelled. Nothing was locked.");
    expect(statusSentence({ ...claimable, state: "locked", role: "buyer" }, { state: "unchecked" })).toBe(
      "It's locked for you. Open the trade and check you can claim before you hand over cash.",
    );
  });
});

describe("disputeBadge (the trades list)", () => {
  const recorded = new Date("2026-12-01T10:00:00Z");
  const disputedAt = new Date("2026-12-01T09:58:00Z");
  const open = protectedTrade({ state: "funded", disputed: true, createTx: "c", fundTx: "f", disputeRecordedAt: recorded, disputedAt });
  const deadline = new Date("2026-12-02T10:00:00Z");
  const promise = new Date("2026-12-04T09:58:00Z");

  it("asks the viewer to answer by the 24 h deadline, counted from when Pairy recorded the dispute", () => {
    expect(disputeBadge(open, recorded.getTime() + 60_000)).toBe(`Dispute open: answer by ${shortWhen(deadline)}`);
  });

  it("points at the arbiter's 72 h promise once the viewer answered or the window closed", () => {
    const answered = { ...open, answers: { seller: { cashHandedOver: true }, buyer: null } };
    expect(disputeBadge(answered, recorded.getTime() + 60_000)).toBe(
      `Dispute open: the arbiter applies the rule by ${shortWhen(promise)}`,
    );
    expect(disputeBadge({ ...answered, role: "buyer" }, recorded.getTime() + 60_000)).toBe(
      `Dispute open: answer by ${shortWhen(deadline)}`,
    );
    expect(disputeBadge(open, deadline.getTime())).toBe(`Dispute open: the arbiter applies the rule by ${shortWhen(promise)}`);
  });

  it("shows nothing without an open dispute on a funded protected trade", () => {
    expect(disputeBadge({ ...open, disputed: false }, recorded.getTime())).toBeNull();
    expect(disputeBadge({ ...open, state: "resolved_buyer" }, recorded.getTime())).toBeNull();
    expect(disputeBadge({ ...open, mode: "claimable" }, recorded.getTime())).toBeNull();
    expect(disputeBadge({ ...open, disputeRecordedAt: null }, recorded.getTime())).toBeNull();
  });
});
