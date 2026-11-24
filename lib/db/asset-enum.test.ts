// Migration 0007 adds 'EURC' to the asset_code enum of a database that is
// already at 0006 and holds XLM and USDC rows. The chain must apply as
// `pnpm db:migrate` does on prod: only the new file runs, nothing is
// rewritten, and the new value is usable right after.

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

describe("0007_asset_eurc", () => {
  it("is the one migration after 0006, a single ALTER TYPE with no empty statement (R-4)", () => {
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, "meta/_journal.json"), "utf8"));
    const last = journal.entries.at(-1);
    expect(last.tag).toBe("0007_asset_eurc");
    expect(journal.entries.at(-2).tag).toBe("0006_listing_remaining");
    const statements = readFileSync(path.join(MIGRATIONS, `${last.tag}.sql`), "utf8").split("--> statement-breakpoint");
    expect(statements.map((s) => s.trim())).toEqual([`ALTER TYPE "public"."asset_code" ADD VALUE 'EURC';`]);
  });

  it("adds EURC after XLM and USDC on a database at 0006 that already holds listings", async () => {
    const db = drizzle(new PGlite(), { schema });
    const before = migrationsBefore("0007");
    await migrate(db, { migrationsFolder: before });
    rmSync(before, { recursive: true, force: true });

    const owner = Keypair.random().publicKey();
    await db.execute(sql`insert into users (public_key) values (${owner})`);
    const listing = (asset: string) =>
      db.execute(
        sql`insert into listings (owner, side, asset, min_amount, max_amount, remaining_amount, fiat_code, rate, city_id, city_name, country_code, latitude, longitude)
            values (${owner}, 'sell_crypto', ${asset}::asset_code, 10, 100, 100, 'TRY', 4.125, '745044', 'Istanbul', 'TR', 41.01384, 28.94966)`,
      );
    await listing("XLM");
    await listing("USDC");
    await expect(listing("EURC")).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/invalid input value for enum asset_code: "EURC"/) },
    });

    await migrate(db, { migrationsFolder: MIGRATIONS });

    const { rows } = await db.execute<{ values: string[] }>(sql`select enum_range(null::asset_code)::text[] as values`);
    expect(rows[0].values).toEqual(["XLM", "USDC", "EURC"]);
    await listing("EURC");
    const { rows: counts } = await db.execute<{ asset: string; n: number }>(
      sql`select asset::text as asset, count(*)::int as n from listings group by asset order by asset`,
    );
    expect(counts).toEqual([
      { asset: "EURC", n: 1 },
      { asset: "USDC", n: 1 },
      { asset: "XLM", n: 1 },
    ]);
  });
});
