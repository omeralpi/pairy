// After a Stellar testnet reset: closes the trades the reset wiped (see
// lib/trade/testnet-reset.ts). --before is the reset time, from the SDF
// announcement; only trades opened before it are considered. Lists them
// without changing anything unless --apply is given.
//
//   DATABASE_URL=... pnpm tsx scripts/ops/testnet-reset.ts --before=2026-12-18T15:00:00Z
//   DATABASE_URL=... pnpm tsx scripts/ops/testnet-reset.ts --before=2026-12-18T15:00:00Z --apply

import { db, pool } from "../../lib/db";
import { closeResetTrades } from "../../lib/trade/testnet-reset";

async function main() {
  const apply = process.argv.includes("--apply");
  const arg = process.argv.find((a) => a.startsWith("--before="))?.slice("--before=".length);
  const before = arg ? new Date(arg) : null;
  if (!before || Number.isNaN(before.getTime())) {
    throw new Error("Give the reset time: --before=<ISO date>, e.g. --before=2026-12-18T15:00:00Z");
  }
  const closed = await closeResetTrades(db, { apply, before });
  for (const t of closed) console.log(`${t.id}  ${t.state.padEnd(7)}  ${t.amount} ${t.asset}`);
  console.log(
    closed.length === 0
      ? "Nothing to close: every open trade still has its accounts or lock on the ledger."
      : `${closed.length} trade(s) ${apply ? "closed" : "would be closed; run again with --apply"}.`,
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
