// The published rule (docs/arbitration.md, "The rule" and its table) and its
// clocks, pinned case by case.

import { describe, expect, it } from "vitest";

import { answerDeadline, promiseDeadline, resolutionReady, ruleOutcome, type Answer } from "./rule";

const HOUR = 3600_000;

describe("ruleOutcome", () => {
  // Every seller × buyer pair: yes, no, or no answer by the deadline.
  it.each<[Answer, Answer, "buyer" | "seller", 1 | 2 | 3]>([
    [true, true, "buyer", 1],
    [true, false, "buyer", 1],
    [true, null, "buyer", 1],
    [null, true, "buyer", 2],
    [null, false, "seller", 3],
    [null, null, "seller", 3],
    [false, true, "seller", 3],
    [false, false, "seller", 3],
    [false, null, "seller", 3],
  ])("seller %s, buyer %s: all to the %s (rule %i)", (seller, buyer, outcome, rule) => {
    expect(ruleOutcome({ seller, buyer })).toEqual({ outcome, rule });
  });
});

describe("answerDeadline and promiseDeadline", () => {
  const disputedAt = new Date("2026-12-01T10:00:00Z");
  // Pairy found the dispute two hours after its ledger time (opened outside Pairy's app).
  const disputeRecordedAt = new Date("2026-12-01T12:00:00Z");

  it("gives each trader 24 hours from when Pairy recorded the dispute, not from its ledger time (DECISIONS 1)", () => {
    const trade = { disputedAt, disputeRecordedAt };
    expect(answerDeadline(trade)).toEqual(new Date("2026-12-02T12:00:00Z"));
  });

  it("promises the arbiter's outcome within 72 hours of the dispute's ledger time", () => {
    const trade = { disputedAt, disputeRecordedAt };
    expect(promiseDeadline(trade)).toEqual(new Date("2026-12-04T10:00:00Z"));
  });
});

describe("resolutionReady", () => {
  const deadline = new Date("2026-12-02T12:00:00Z");
  const before = new Date(deadline.getTime() - HOUR);

  it("is ready as soon as both traders have answered, before the deadline", () => {
    expect(resolutionReady({ seller: false, buyer: true }, deadline, before)).toBe(true);
    expect(resolutionReady({ seller: true, buyer: true }, deadline, before)).toBe(true);
  });

  it("waits while one answer is missing and the window is open", () => {
    expect(resolutionReady({ seller: true, buyer: null }, deadline, before)).toBe(false);
    expect(resolutionReady({ seller: null, buyer: false }, deadline, before)).toBe(false);
    expect(resolutionReady({ seller: null, buyer: null }, deadline, new Date(deadline.getTime() - 1))).toBe(false);
  });

  it("is ready once the window has closed, answered or not", () => {
    expect(resolutionReady({ seller: null, buyer: null }, deadline, deadline)).toBe(true);
    expect(resolutionReady({ seller: null, buyer: true }, deadline, new Date(deadline.getTime() + HOUR))).toBe(true);
  });
});
