// Every protected trade, for EVIDENCE.md: dispute times, both answers, the
// rule and the outcome, each resolution prepared in Pairy with its hash and
// links, and every missed 72-hour promise (lib/escrow/protected-report.ts).
// Read only: the database is read in one read-only transaction, and the only
// other read is the arbiter account's threshold from Horizon. Nothing is
// signed or sent. Prints Markdown, or JSON with --json.
//
//   DATABASE_URL=... pnpm tsx scripts/ops/protected-report.ts > protected-report.md
//   DATABASE_URL=... pnpm tsx scripts/ops/protected-report.ts --json > protected-report.json

import { db, pool } from "../../lib/db";
import { ARBITER_ACCOUNT } from "../../lib/escrow/config";
import { protectedReport, protectedReportMarkdown } from "../../lib/escrow/protected-report";
import { horizon } from "../../lib/stellar/horizon";

/** The signatures a resolve needs, counted as server/api/routers/arbiter.ts counts them; null when Horizon can't be read. */
async function arbiterThreshold(): Promise<number | null> {
  try {
    const { thresholds } = await horizon.loadAccount(ARBITER_ACCOUNT);
    return Math.max(thresholds.low_threshold, thresholds.med_threshold);
  } catch (e) {
    console.error(`Couldn't read the arbiter account from Horizon (${e instanceof Error ? e.message : e}); signatures are shown without the threshold.`);
    return null;
  }
}

async function main() {
  const json = process.argv.includes("--json");
  const report = await protectedReport(db, { now: new Date(), threshold: await arbiterThreshold() });
  console.log(json ? JSON.stringify(report, null, 2) : protectedReportMarkdown(report));
  await pool.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
