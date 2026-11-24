// Migration 0006 adds listings.remaining_amount to a database that already has
// trades. The backfill counts every existing trade (DECISIONS 2): what is left
// is the maximum less every trade that still holds or used up its amount,
// never below zero.

import { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@stellar/stellar-sdk";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { listings } from "@/lib/db/schema";

const MIGRATIONS = path.join(process.cwd(), "drizzle");

/** A copy of the migrations folder that stops before `tag`. */
function migrationsBefore(tag: string): string {
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
  const kept = journal.entries.filter((e: { tag: string }) => e.tag < tag);
  expect(kept.length).toBeLessThan(journal.entries.length);
  const dir = mkdtempSync(path.join(tmpdir(), "pairy-migrations-"));
  mkdirSync(path.join(dir, "meta"));
  writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: kept }));
  for (const e of kept) copyFileSync(path.join(MIGRATIONS, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

type Settled = { balanceId?: string; lockTx?: string; claimTx?: string; reclaimTx?: string };
const lock = (n: number) => ({ balanceId: n.toString(16).padStart(72, "0"), lockTx: "a".repeat(64) });

describe("0006_listing_remaining backfill", () => {
  it("sets remaining_amount to max less every listed, agreed, locked and claimed trade, clamped at 0", async () => {
    const db = drizzle(new PGlite(), { schema });
    const before = migrationsBefore("0006");
    await migrate(db, { migrationsFolder: before });
    rmSync(before, { recursive: true, force: true });

    // Rows as the 0005 schema holds them, so plain SQL: the typed schema
    // already has the new column.
    const [owner, buyer] = [0, 1].map(() => Keypair.random().publicKey());
    await db.execute(sql`insert into users (public_key) values (${owner}), (${buyer})`);
    const listing = async () => {
      const { rows } = await db.execute<{ id: string }>(
        sql`insert into listings (owner, side, asset, min_amount, max_amount, fiat_code, rate, city_id, city_name, country_code, latitude, longitude)
            values (${owner}, 'sell_crypto', 'XLM', 10, 100, 'TRY', 4.125, '745044', 'Istanbul', 'TR', 41.01384, 28.94966) returning id`,
      );
      return rows[0].id;
    };
    const trade = (listingId: string, amount: string, state: string, settled: Settled = {}) =>
      db.execute(
        sql`insert into trades (listing_id, seller, buyer, opened_by, asset, amount, fiat_code, fiat_amount, state, window_seconds, balance_id, lock_tx, claim_tx, reclaim_tx)
            values (${listingId}, ${owner}, ${buyer}, 'buyer', 'XLM', ${amount}, 'TRY', 1, ${state}, 259200,
                    ${settled.balanceId ?? null}, ${settled.lockTx ?? null}, ${settled.claimTx ?? null}, ${settled.reclaimTx ?? null})`,
      );

    const everyState = await listing();
    // Counted: 10 + 20 + 30 + 5 = 65.
    await trade(everyState, "10", "listed");
    await trade(everyState, "20", "agreed");
    await trade(everyState, "30", "locked", lock(1));
    await trade(everyState, "5", "claimed", { ...lock(2), claimTx: "b".repeat(64) });
    // Given back: not counted.
    await trade(everyState, "50", "reclaimed", { ...lock(3), reclaimTx: "c".repeat(64) });
    await trade(everyState, "60", "cancelled");
    // Phase 1 had no reservation, so a listing may hold more than its maximum.
    const oversold = await listing();
    await trade(oversold, "100", "listed");
    await trade(oversold, "100", "claimed", { ...lock(4), claimTx: "b".repeat(64) });
    const untouched = await listing();

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const remaining = async (id: string) =>
      (await db.select({ remaining: listings.remainingAmount }).from(listings).where(eq(listings.id, id)))[0].remaining;
    expect(await remaining(everyState)).toBe("35.0000000");
    expect(await remaining(oversold)).toBe("0.0000000");
    expect(await remaining(untouched)).toBe("100.0000000");
  });
});
