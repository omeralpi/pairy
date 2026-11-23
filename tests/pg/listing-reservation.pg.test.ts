// The listing reservation race on real Postgres. pglite (the default suite)
// runs one transaction at a time, so tests/ci/listing-reservation-concurrency
// checks the remaining-amount rule only; this file proves the listing row
// lock: ten buyers open 60 at once on a listing of 100 over real connections,
// and exactly one may win.
//
// Without help the ten opens drift apart by more than the microseconds
// between a check and its commit, so a check with no lock would pass most
// runs by luck. A gate holds them together: a separate client takes
// `LOCK TABLE trades IN SHARE MODE` in an open transaction, every open blocks
// on its trades INSERT (or, with a correct lock, on the listing row), the gate
// waits until all ten are blocked, then commits and lets them race for real.
//
// Needs PG_TEST_URL, a superuser or CREATEDB connection to a Postgres server
// (for example the repo's docker-compose Postgres,
// postgresql://pairy:pairy@127.0.0.1:35433/pairy). The test creates its own
// database next to it and drops it afterwards, so the dev database is left
// alone. Without PG_TEST_URL the file is skipped; the pg-concurrency CI job
// (WP-12) sets it.
//
// RED until WP-07 lands the remaining amount: marked `it.fails` so a local
// run against Postgres stays green; WP-07 turns it into plain `it`. The
// branch red/listing-reservation carries the unmarked version.

import { Keypair } from "@stellar/stellar-sdk";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { listings, users } from "@/lib/db/schema";
import { appRouter } from "@/server/api/root";
import { createCallerFactory } from "@/server/api/trpc";

const PG_TEST_URL = process.env.PG_TEST_URL;
const BUYERS = 10;
const GATE_DEADLINE_MS = 10_000;

const createCaller = createCallerFactory(appRouter);

describe.skipIf(!PG_TEST_URL)("listing-reservation-concurrency (postgres; set PG_TEST_URL to run)", () => {
  const dbName = `pairy_test_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: PG_TEST_URL });
  let pool: Pool;
  let db: Db;
  let gate: Client;

  beforeAll(async () => {
    const testUrl = new URL(PG_TEST_URL!);
    testUrl.pathname = `/${dbName}`;
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    // One connection per buyer, so every open really runs in its own session.
    pool = new Pool({ connectionString: testUrl.toString(), max: BUYERS });
    db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    gate = new Client({ connectionString: testUrl.toString() });
    await gate.connect();
  });

  afterAll(async () => {
    await gate.end();
    await pool.end();
    // pool.end() resolves before the server has seen every disconnect; drop
    // only once the database has no sessions, or killing them surfaces as
    // unhandled client errors.
    for (let i = 0; i < 100 && (await sessions()) > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await admin.query(`drop database "${dbName}" with (force)`);
    await admin.end();
  });

  async function sessions(): Promise<number> {
    const { rows } = await admin.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = $1",
      [dbName],
    );
    return rows[0].n;
  }

  /** Sessions of the test database blocked on a heavyweight lock. */
  async function blocked(): Promise<number> {
    // Inside the gate's transaction pg_stat_activity is a frozen snapshot
    // unless it is cleared first.
    await gate.query("select pg_stat_clear_snapshot()");
    const { rows } = await gate.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    return rows[0].n;
  }

  it.fails("accepts exactly one of ten simultaneous trades of 60 on a listing of 100", async () => {
    const owner = Keypair.random().publicKey();
    const buyers = Array.from({ length: BUYERS }, () => Keypair.random().publicKey());
    await db.insert(users).values([owner, ...buyers].map((publicKey) => ({ publicKey })));
    const [listing] = await db
      .insert(listings)
      .values({
        owner,
        side: "sell_crypto",
        asset: "XLM",
        minAmount: "10",
        maxAmount: "100",
        fiatCode: "TRY",
        rate: "4.1250",
        cityId: "745044",
        cityName: "Istanbul",
        countryCode: "TR",
        latitude: "41.01384",
        longitude: "28.94966",
      })
      .returning();

    // Hold every trades INSERT until all ten opens are waiting.
    await gate.query("begin");
    await gate.query("lock table trades in share mode");
    let settled = 0;
    const opens = buyers.map((publicKey) =>
      createCaller({ db, session: { publicKey }, resHeaders: new Headers() })
        .trade.open({ listingId: listing.id, amount: "60" })
        .finally(() => settled++),
    );
    const deadline = Date.now() + GATE_DEADLINE_MS;
    let waiting = 0;
    while ((waiting = await blocked()) + settled < BUYERS && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const reachedGate = waiting + settled;
    await gate.query("commit");
    const results = await Promise.allSettled(opens);
    expect(reachedGate, "not every open reached the gate").toBeGreaterThanOrEqual(BUYERS);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length, `${fulfilled.length} fulfilled, expected 1`).toBe(1);
    expect(rejected).toHaveLength(BUYERS - 1);
    for (const r of rejected) expect(r.reason.message).toMatch(/Only 40 XLM left/);
  });
});
