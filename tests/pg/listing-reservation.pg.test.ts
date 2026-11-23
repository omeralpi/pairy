// The listing reservation race on real Postgres. pglite (the default suite)
// runs one transaction at a time, so tests/ci/listing-reservation-concurrency
// proves the remaining-amount check only; this file proves the listing row
// lock with ten buyers opening at once over a pool of real connections.
//
// Needs PG_TEST_URL (for example the repo's docker-compose Postgres,
// postgresql://pairy:pairy@127.0.0.1:35433/pairy). Without it the file is
// skipped; the pg-concurrency CI job (WP-12) sets it.
//
// RED until WP-07 lands the remaining amount: marked `it.fails` so a local
// run against Postgres stays green; WP-07 turns it into plain `it`. The
// branch red/listing-reservation carries the unmarked version.

import { Keypair } from "@stellar/stellar-sdk";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { listings, users } from "@/lib/db/schema";
import { appRouter } from "@/server/api/root";
import { createCallerFactory } from "@/server/api/trpc";

const PG_TEST_URL = process.env.PG_TEST_URL;
const BUYERS = 10;

const createCaller = createCallerFactory(appRouter);

describe.skipIf(!PG_TEST_URL)("listing-reservation-concurrency (postgres; set PG_TEST_URL to run)", () => {
  // One connection per buyer, so every open really runs in its own session.
  const pool = new Pool({ connectionString: PG_TEST_URL, max: BUYERS });
  const db = drizzle({ client: pool, schema });

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  });

  afterAll(async () => {
    await pool.end();
  });

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

    const results = await Promise.allSettled(
      buyers.map((publicKey) =>
        createCaller({ db, session: { publicKey }, resHeaders: new Headers() }).trade.open({
          listingId: listing.id,
          amount: "60",
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length, `${fulfilled.length} fulfilled, expected 1`).toBe(1);
    expect(rejected).toHaveLength(BUYERS - 1);
    for (const r of rejected) expect(r.reason.message).toMatch(/Only 40 XLM left/);
  });
});
