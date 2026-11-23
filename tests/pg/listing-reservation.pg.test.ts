// The listing reservation race on real Postgres. pglite (the default suite)
// runs one transaction at a time, so tests/ci/listing-reservation-concurrency
// checks the remaining-amount rule only; this file proves the listing row
// lock: ten buyers open 60 at once on a listing of 100 over real connections,
// and exactly one may win. A second test holds a cancel and an open on the
// same listing together and expects both to complete (the lock order,
// listing then trade, is what keeps them from deadlocking).
//
// Without help the calls drift apart by more than the microseconds between a
// check and its commit, so a check with no lock would pass most runs by luck.
// A gate holds them together: a separate client takes
// `LOCK TABLE trades IN SHARE MODE` in an open transaction, every call blocks
// on its trades write (or, with a correct lock, on the listing row), the gate
// waits until all of them are blocked, then commits and lets them race for
// real.
//
// Needs PG_TEST_URL, a superuser or CREATEDB connection to a Postgres server
// (for example the repo's docker-compose Postgres,
// postgresql://pairy:pairy@127.0.0.1:35433/pairy). The test creates its own
// database next to it and drops it afterwards, so the dev database is left
// alone. Without PG_TEST_URL the file is skipped; the pg-concurrency CI job
// sets it, and REQUIRE_PG=1 so that a skip fails the job instead.

import { Keypair } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { listings, trades, users } from "@/lib/db/schema";
import { appRouter } from "@/server/api/root";
import { createCallerFactory } from "@/server/api/trpc";

const PG_TEST_URL = process.env.PG_TEST_URL;
// Set by ci.yml's pg-concurrency job: vitest reports a skipped file as
// "1 skipped" and exits 0, so without this the job could go green on a skip.
const requirePg = process.env.REQUIRE_PG === "1";
const BUYERS = 10;
const GATE_DEADLINE_MS = 10_000;

const createCaller = createCallerFactory(appRouter);

describe.runIf(!PG_TEST_URL && requirePg)("listing-reservation-concurrency (postgres; REQUIRE_PG=1)", () => {
  it("has a PG_TEST_URL to run against", () => {
    expect.fail("PG_TEST_URL is not set, so the postgres race could not run");
  });
});

describe.skipIf(!PG_TEST_URL)("listing-reservation-concurrency (postgres; set PG_TEST_URL to run)", () => {
  const dbName = `pairy_test_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: PG_TEST_URL });
  let created = false;
  let pool: Pool;
  let db: Db;
  let gate: Client;

  beforeAll(async () => {
    const testUrl = new URL(PG_TEST_URL!);
    testUrl.pathname = `/${dbName}`;
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    created = true;
    // One connection per buyer, so every open really runs in its own session.
    pool = new Pool({ connectionString: testUrl.toString(), max: BUYERS });
    db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    gate = new Client({ connectionString: testUrl.toString() });
    await gate.connect();
  });

  afterAll(async () => {
    // A failed setup leaves gate or pool unset, and may leave the database.
    await gate?.end();
    await pool?.end();
    if (created) {
      // pool.end() resolves before the server has seen every disconnect; drop
      // only once the database has no sessions, or killing them surfaces as
      // unhandled client errors.
      for (let i = 0; i < 100 && (await sessions()) > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await admin.query(`drop database "${dbName}" with (force)`);
    }
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

  /**
   * Holds every trades INSERT and UPDATE until all of `start`'s calls are
   * waiting (or have already settled), then lets them go at once.
   * `reachedGate` is how many got there before the deadline.
   */
  async function throughGate<T>(start: () => Promise<T>[]): Promise<{ results: PromiseSettledResult<T>[]; reachedGate: number }> {
    await gate.query("begin");
    await gate.query("lock table trades in share mode");
    let settled = 0;
    const calls = start().map((call) => call.finally(() => settled++));
    const deadline = Date.now() + GATE_DEADLINE_MS;
    let waiting = 0;
    while ((waiting = await blocked()) + settled < calls.length && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const reachedGate = waiting + settled;
    await gate.query("commit");
    return { results: await Promise.allSettled(calls), reachedGate };
  }

  function caller(publicKey: string) {
    return createCaller({ db, session: { publicKey }, resHeaders: new Headers() });
  }

  /** An active 10–100 XLM listing and `count` buyers, all with user rows. */
  async function seedListing(count: number) {
    const owner = Keypair.random().publicKey();
    const buyers = Array.from({ length: count }, () => Keypair.random().publicKey());
    await db.insert(users).values([owner, ...buyers].map((publicKey) => ({ publicKey })));
    const [listing] = await db
      .insert(listings)
      .values({
        owner,
        side: "sell_crypto",
        asset: "XLM",
        minAmount: "10",
        maxAmount: "100",
        remainingAmount: "100",
        fiatCode: "TRY",
        rate: "4.1250",
        cityId: "745044",
        cityName: "Istanbul",
        countryCode: "TR",
        latitude: "41.01384",
        longitude: "28.94966",
      })
      .returning();
    return { listing, buyers };
  }

  it("accepts exactly one of ten simultaneous trades of 60 on a listing of 100", async () => {
    const { listing, buyers } = await seedListing(BUYERS);

    const { results, reachedGate } = await throughGate(() =>
      buyers.map((publicKey) => caller(publicKey).trade.open({ listingId: listing.id, amount: "60" })),
    );
    expect(reachedGate, "not every open reached the gate").toBeGreaterThanOrEqual(BUYERS);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length, `${fulfilled.length} fulfilled, expected 1`).toBe(1);
    expect(rejected).toHaveLength(BUYERS - 1);
    for (const r of rejected) expect(r.reason.message).toMatch(/Only 40 XLM left/);
  });

  // A transition and an open on the same listing both take the listing row
  // first; held together at the gate, neither may deadlock or hang.
  it("completes a cancel and an open on the same listing at once", async () => {
    const {
      listing,
      buyers: [first, second],
    } = await seedListing(2);
    const trade = await caller(first).trade.open({ listingId: listing.id, amount: "60" });

    const { results, reachedGate } = await throughGate(() => [
      caller(first).trade.cancel({ tradeId: trade.id }),
      caller(second).trade.open({ listingId: listing.id, amount: "10" }),
    ]);
    expect(reachedGate, "not both calls reached the gate").toBeGreaterThanOrEqual(2);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.map((r) => String(r.reason)), "both calls must complete").toEqual([]);
    const rows = await db.select({ state: trades.state }).from(trades).where(eq(trades.listingId, listing.id));
    expect(rows.map((r) => r.state).sort()).toEqual(["cancelled", "listed"]);
    const [after] = await db.select({ remainingAmount: listings.remainingAmount }).from(listings).where(eq(listings.id, listing.id));
    expect(after.remainingAmount).toBe("90.0000000");
  });
});
