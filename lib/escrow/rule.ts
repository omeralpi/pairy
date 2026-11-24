// The published rule as code (docs/arbitration.md, "The rule"; the two must
// agree, rule.test.ts pins the table). The outcome follows from the two
// answers alone: no discretion, no case left to judgement.

import { ANSWER_WINDOW_MS, ARBITER_PROMISE_MS } from "./config";

/** A trader's answer to "Was the cash handed over in full?": true = yes, null = no answer. */
export type Answer = boolean | null;
/** Who gets the whole escrow, less Trustless Work's 0.3%. */
export type Outcome = "buyer" | "seller";

/**
 * 1: the seller says yes → the buyer. 2: the seller sent no answer and the
 * buyer says yes → the buyer. 3: everything else, the contested case included
 * → the seller. Only meaningful once resolutionReady, when a null is final.
 */
export function ruleOutcome(a: { seller: Answer; buyer: Answer }): { outcome: Outcome; rule: 1 | 2 | 3 } {
  if (a.seller === true) return { outcome: "buyer", rule: 1 };
  if (a.seller === null && a.buyer === true) return { outcome: "buyer", rule: 2 };
  return { outcome: "seller", rule: 3 };
}

/** 24 hours from when Pairy recorded the dispute and showed it, not from the dispute's ledger time (DECISIONS 1). */
export function answerDeadline(t: { disputeRecordedAt: Date }): Date {
  return new Date(t.disputeRecordedAt.getTime() + ANSWER_WINDOW_MS);
}

/** The arbiter's promise: 72 hours from the dispute transaction's ledger time. */
export function promiseDeadline(t: { disputedAt: Date }): Date {
  return new Date(t.disputedAt.getTime() + ARBITER_PROMISE_MS);
}

/** The arbiter acts once both traders have answered, or once the answer window has closed; never before. */
export function resolutionReady(a: { seller: Answer; buyer: Answer }, deadline: Date, now: Date): boolean {
  return (a.seller !== null && a.buyer !== null) || now.getTime() >= deadline.getTime();
}
