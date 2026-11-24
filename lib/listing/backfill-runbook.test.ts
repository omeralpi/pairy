// The release runbook in docs/remaining-amount-rehearsal-2026-11-24.md ("What this
// means for the release") has WP-44 re-run the remaining-amount backfill by hand.
// Its SQL must count the same trade states as recomputeRemaining, or the re-run
// writes a too-high amount once protected trades exist (DECISIONS O-42).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { COUNTED_STATES } from "./remaining";

const doc = readFileSync(path.join(process.cwd(), "docs/remaining-amount-rehearsal-2026-11-24.md"), "utf8");
const runbook = doc.slice(doc.indexOf("## What this means for the release"));
const sqlBlocks = [...runbook.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
const stateLists = sqlBlocks.flatMap((s) =>
  [...s.matchAll(/"state"::text IN \(([^)]*)\)/g)].map((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])),
);

describe("the backfill re-run in the release runbook", () => {
  it("has one state list, in a SQL block of the release section", () => {
    expect(runbook.startsWith("## What this means for the release")).toBe(true);
    expect(stateLists).toHaveLength(1);
  });

  it("counts exactly COUNTED_STATES, compared as text (R-4)", () => {
    expect(stateLists[0]).toEqual([...COUNTED_STATES]);
  });
});
