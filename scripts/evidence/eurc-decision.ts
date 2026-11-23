// The day-10 rule for the test euro source (FIXES X-04, DECISIONS 16), kept
// pure so it can be tested with a fixed day. eurc-source.ts feeds it what
// Horizon says the treasury has received and holds. The rule looks at what
// was received, never at the holding: `acquire` spends from this treasury,
// so a spent treasury must not read as "no EURC arrived".

import { toStroops } from "../../tests/integration/testnet";

/** FIXES X-04 lowered the plan's 100 to 10: the faucet pays a few EURC at a time. */
export const PASS_MARK = "10.0000000";
/** Day 10. Nothing received by then: TEUR (DECISIONS 16), issued that day. */
export const DECISION_DAY = "2026-12-03";

export type TreasuryReport = {
  account: string;
  /** Sum of every EURC credit to the account since it was made, not the holding. */
  eurcReceived: string;
  eurcBalance: string;
};

export function passes(eurcReceived: string): boolean {
  return toStroops(eurcReceived) >= toStroops(PASS_MARK);
}

/** `day` is a UTC calendar date, YYYY-MM-DD. */
export function decide(treasury: TreasuryReport | null, day: string): string {
  if (!treasury) return "no treasury yet: run scripts/ops/create-treasury.ts EURC";
  if (passes(treasury.eurcReceived)) {
    return `pass: EURC is the third asset (${treasury.eurcReceived} received, ${treasury.eurcBalance} held)`;
  }
  if (toStroops(treasury.eurcReceived) > 0n) {
    return `EURC arrived (${treasury.eurcReceived} received, below the ${PASS_MARK} pass mark): EURC stays the code path at 1 EURC per evidence run (X-04); ask the faucet again`;
  }
  return day >= DECISION_DAY
    ? `no EURC received by day 10 (${DECISION_DAY}): issue TEUR (DECISIONS 16)`
    : `waiting for Circle's faucet (HX-7) to pay ${treasury.account}`;
}
