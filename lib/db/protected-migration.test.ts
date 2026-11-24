// Migration 0008 adds protected trades. On prod it runs in the same
// `pnpm db:migrate` as 0006 and 0007, and drizzle applies every pending file
// in one transaction, so 0008 may not use a trade_state value it adds as a
// literal, a DEFAULT or an index predicate: Postgres refuses an enum value
// before the transaction that added it commits ("unsafe use of new value").
// Every comparison with a new state is made on `state::text` (FIXES R-4).

import { PGlite } from "@electric-sql/pglite";
import { Keypair } from "@stellar/stellar-sdk";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

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

describe("0008_protected_trades", () => {
  it("is the one migration after 0007, split into statements with no empty one (R-4)", () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
    expect(journal.entries.map((e: { tag: string }) => e.tag).slice(-3)).toEqual([
      "0006_listing_remaining",
      "0007_asset_eurc",
      "0008_protected_trades",
    ]);
    const statements = readFileSync(path.join(MIGRATIONS, "0008_protected_trades.sql"), "utf8").split("--> statement-breakpoint");
    expect(statements.length).toBeGreaterThan(30);
    for (const s of statements) {
      expect(s.trim()).not.toBe("");
      // One statement per chunk: pglite refuses several in one prepared statement.
      expect(s.trim().replace(/;$/, "")).not.toContain(";");
    }
  });

  it("applies 0006, 0007 and 0008 in one run on a database at 0005 holding Phase 1 trades, leaving them intact", async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema });
    const before = migrationsBefore("0006");
    await migrate(db, { migrationsFolder: before });
    rmSync(before, { recursive: true, force: true });

    // Rows as the 0005 schema holds them, so plain SQL: the typed schema
    // already has the new columns.
    const [owner, buyer] = [0, 1].map(() => Keypair.random().publicKey());
    await db.execute(sql`insert into users (public_key) values (${owner}), (${buyer})`);
    const { rows: listingRows } = await db.execute<{ id: string }>(
      sql`insert into listings (owner, side, asset, min_amount, max_amount, fiat_code, rate, city_id, city_name, country_code, latitude, longitude)
          values (${owner}, 'sell_crypto', 'USDC', 10, 100, 'TRY', 4.125, '745044', 'Istanbul', 'TR', 41.01384, 28.94966) returning id`,
    );
    const listingId = listingRows[0].id;
    const trade = (amount: string, state: string, extra = sql``) =>
      db.execute(
        sql`insert into trades (listing_id, seller, buyer, opened_by, asset, amount, fiat_code, fiat_amount, state, window_seconds, balance_id, lock_tx, claim_tx, reclaim_tx, disputed, locked_at)
            values (${listingId}, ${owner}, ${buyer}, 'buyer', 'USDC', ${amount}, 'TRY', 1, ${state}, 259200, ${extra})`,
      );
    const lock = (n: number) => sql`${n.toString(16).padStart(72, "0")}, ${"a".repeat(64)}`;
    await trade("10", "listed", sql`null, null, null, null, false, null`);
    await trade("20", "agreed", sql`null, null, null, null, true, null`);
    await trade("30", "locked", sql`${lock(1)}, null, null, true, now()`);
    await trade("5", "claimed", sql`${lock(2)}, ${"b".repeat(64)}, null, false, now()`);
    await trade("50", "reclaimed", sql`${lock(3)}, null, ${"c".repeat(64)}, false, now()`);
    await trade("60", "cancelled", sql`null, null, null, null, false, null`);
    const phase1 = sql`select id, state::text, disputed, amount, balance_id, lock_tx, claim_tx, reclaim_tx, locked_at, window_seconds from trades order by amount`;
    const { rows: tradesBefore } = await db.execute(phase1);
    const { rows: applied } = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const { rows: appliedAfter } = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(appliedAfter[0].n - applied[0].n).toBe(3);
    expect((await db.execute(phase1)).rows).toEqual(tradesBefore);
    const { rows: added } = await db.execute(
      sql`select distinct mode::text, acceptance_version, escrow_contract_id, fund_tx, dispute_recorded_at from trades`,
    );
    expect(added).toEqual([{ mode: "claimable", acceptance_version: null, escrow_contract_id: null, fund_tx: null, dispute_recorded_at: null }]);
    // 0006's backfill ran in the same transaction: 100 less 10 + 20 + 30 + 5.
    const { rows: left } = await db.execute<{ remaining: string }>(sql`select remaining_amount::text as remaining from listings`);
    expect(left).toEqual([{ remaining: "35.0000000" }]);
    // The recompute and the listing lock read trades by listing (WP-07's carry-over).
    const { rows: indexes } = await db.execute<{ def: string }>(
      sql`select indexdef as def from pg_indexes where indexname = 'trades_listing_idx'`,
    );
    expect(indexes).toEqual([{ def: expect.stringMatching(/ON public\.trades USING btree \(listing_id\)$/) }]);
    const { rows: states } = await db.execute<{ values: string[] }>(sql`select enum_range(null::trade_state)::text[] as values`);
    expect(states[0].values).toEqual([
      "listed", "agreed", "locked", "claimed", "reclaimed", "cancelled",
      "escrow_created", "funded", "released", "resolved_buyer", "resolved_seller",
    ]);

    // The old build's insert, which names none of the new columns, still works.
    await trade("1", "listed", sql`null, null, null, null, false, null`);
    // A protected trade fits once the transaction has committed.
    await db.insert(schema.trades).values({
      listingId,
      seller: owner,
      buyer,
      openedBy: "buyer",
      asset: "USDC",
      amount: "4",
      fiatCode: "TRY",
      fiatAmount: "16.50",
      windowSeconds: 0,
      mode: "protected",
      state: "funded",
      acceptanceVersion: "c785c11a",
      sellerAcceptedAt: new Date(),
      buyerAcceptedAt: new Date(),
      escrowAdmin: Keypair.random().publicKey(),
      escrowContractId: "C" + "A".repeat(55),
      createTx: "d".repeat(64),
      fundTx: "e".repeat(64),
      fundedAt: new Date(),
    });
    await client.close();
  });
});
