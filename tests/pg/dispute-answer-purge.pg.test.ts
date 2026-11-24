// A dispute answer racing the trade's end, on real Postgres. pglite (the
// default suite) runs one transaction at a time, so escrow.test.ts can only
// check the two orders one after the other; this file proves the row lock
// that makes them the only two. escrow.answer reads the trade FOR SHARE (as
// chat.send does) before it inserts the answer, so a terminal transition,
// which takes the trade FOR UPDATE, waits for the answer to commit and its
// purge then clears the new note. Without FOR SHARE the transition does not
// wait: its purge runs before the answer's row is committed, cannot see it,
// and the note outlives the trade (SOW D3: notes go with the chat).
//
// The test holds the answer between its read and its insert: the pool's
// connections pass every query through, except that the answer's insert is
// kept back until released. The terminal transition runs meanwhile. With FOR
// SHARE it waits on the trade row until the answer commits; without it, it
// ends the trade and purges before the answer's note exists. (Once inserted,
// the answer's foreign key locks the trade row anyway, so only this window
// tells the two apart.)
//
// Needs PG_TEST_URL, as tests/pg/listing-reservation.pg.test.ts does; without
// it the file is skipped (REQUIRE_PG=1 makes the skip fail).

import { Keypair } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { disputeAnswers, listings, trades, users } from "@/lib/db/schema";
import { ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { transitionTrade } from "@/lib/trade/persist";
import { appRouter } from "@/server/api/root";
import { createCallerFactory } from "@/server/api/trpc";

const PG_TEST_URL = process.env.PG_TEST_URL;
const requirePg = process.env.REQUIRE_PG === "1";
const GATE_DEADLINE_MS = 10_000;

const createCaller = createCallerFactory(appRouter);

describe.runIf(!PG_TEST_URL && requirePg)("dispute-answer-purge (postgres; REQUIRE_PG=1)", () => {
  it("has a PG_TEST_URL to run against", () => {
    expect.fail("PG_TEST_URL is not set, so the postgres race could not run");
  });
});

describe.skipIf(!PG_TEST_URL)("dispute-answer-purge (postgres; set PG_TEST_URL to run)", () => {
  const dbName = `pairy_test_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: PG_TEST_URL });
  let created = false;
  let pool: Pool;
  let db: Db;
  let probe: Client;

  beforeAll(async () => {
    const testUrl = new URL(PG_TEST_URL!);
    testUrl.pathname = `/${dbName}`;
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    created = true;
    pool = new Pool({ connectionString: testUrl.toString(), max: 4 });
    pool.on("connect", holdAnswerInserts);
    db = drizzle({ client: pool, schema });
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
    probe = new Client({ connectionString: testUrl.toString() });
    await probe.connect();
  });

  afterAll(async () => {
    await probe?.end();
    // After a hang pool.end() waits for the hung call forever: give it 5 s,
    // then drop the database anyway, which ends that session (the run is red
    // already).
    const ended = await Promise.race([(pool?.end() ?? Promise.resolve()).then(() => true), sleep(5_000, false, { ref: false })]);
    if (created) {
      for (let i = 0; ended && i < 100 && (await sessions()) > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await admin.query(`drop database "${dbName}" with (force)`);
    }
    await admin.end();
  });

  async function sessions(): Promise<number> {
    const { rows } = await admin.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = $1", [dbName]);
    return rows[0].n;
  }

  /** Set by a test: the next insert into dispute_answers waits for `release`; `reached` resolves when it is held. */
  let hold: { release: Promise<void>; reached: () => void } | null = null;
  function holdAnswerInserts(client: PoolClient) {
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    (client as { query: unknown }).query = (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : (args[0] as { text?: string } | undefined)?.text;
      if (hold && /^insert into "dispute_answers"/.test(text ?? "")) {
        const { release, reached } = hold;
        hold = null;
        reached();
        return release.then(() => query(...args));
      }
      return query(...args);
    };
  }

  /** Sessions of the test database blocked on a heavyweight lock. */
  async function blocked(): Promise<number> {
    await probe.query("select pg_stat_clear_snapshot()");
    const { rows } = await probe.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    return rows[0].n;
  }

  /** Polls until `n` calls are blocked or settled (or the deadline passes); returns how many are blocked. */
  async function waitForBlocked(n: number, settled = () => 0): Promise<number> {
    const deadline = Date.now() + GATE_DEADLINE_MS;
    let waiting = 0;
    while ((waiting = await blocked()) + settled() < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return waiting;
  }

  /** A funded protected trade with a dispute Pairy recorded a minute ago. */
  async function disputedTrade() {
    const [seller, buyer] = [Keypair.random().publicKey(), Keypair.random().publicKey()];
    await db.insert(users).values([seller, buyer].map((publicKey) => ({ publicKey })));
    const [listing] = await db
      .insert(listings)
      .values({
        owner: seller,
        side: "sell_crypto",
        asset: "USDC",
        minAmount: "1",
        maxAmount: "100",
        remainingAmount: "95",
        fiatCode: "TRY",
        rate: "41.0000",
        cityId: "745044",
        cityName: "Istanbul",
        countryCode: "TR",
        latitude: "41.01384",
        longitude: "28.94966",
      })
      .returning();
    const now = Date.now();
    const [trade] = await db
      .insert(trades)
      .values({
        listingId: listing.id,
        seller,
        buyer,
        openedBy: "buyer",
        mode: "protected",
        asset: "USDC",
        amount: "5",
        fiatCode: "TRY",
        fiatAmount: "205.00",
        windowSeconds: 0,
        acceptanceVersion: ACCEPTANCE_VERSION,
        sellerAcceptedAt: new Date(now - 3600_000),
        buyerAcceptedAt: new Date(now - 3600_000),
        escrowAdmin: Keypair.random().publicKey(),
        escrowContractId: "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34",
        createTx: "1".repeat(64),
        fundTx: "2".repeat(64),
        fundedAt: new Date(now - 3000_000),
        state: "funded",
        disputed: true,
        disputeTx: "3".repeat(64),
        disputedAt: new Date(now - 120_000),
        disputeRecordedAt: new Date(now - 60_000),
        disputeOpenedBy: "buyer",
      })
      .returning();
    return { trade, seller, buyer };
  }

  it("lets a terminal transition purge an answer's note that was being saved when it started", async () => {
    const { trade, seller } = await disputedTrade();
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((r) => (reached = r));
    hold = { release: new Promise<void>((r) => (release = r)), reached };
    // The answer reads the trade FOR SHARE and is held just before its insert.
    const answer = createCaller({ db, session: { publicKey: seller }, resHeaders: new Headers() }).escrow.answer({
      tradeId: trade.id,
      cashHandedOver: true,
      note: "Paid in full at the cafe.",
    });
    await held;
    // The arbiter's resolution lands meanwhile and is recorded.
    let resolveSettled = 0;
    const resolve = transitionTrade(db, trade.id, { type: "resolve", by: "arbiter", outcome: "buyer", txHash: "4".repeat(64), resolvedAt: new Date() }).finally(
      () => resolveSettled++,
    );
    // With FOR SHARE it waits on the trade row until the answer commits; without it, it ends the trade now.
    const resolveWaiting = await waitForBlocked(1, () => resolveSettled);
    const endedFirst = resolveSettled;
    release();
    const [answered, resolved] = await Promise.allSettled([answer, resolve]);

    expect({ resolveWaiting, endedFirst }).toEqual({ resolveWaiting: 1, endedFirst: 0 });
    expect(answered.status).toBe("fulfilled");
    expect(resolved).toMatchObject({ status: "fulfilled", value: { state: "resolved_buyer" } });
    // The answer stays in the timeline; its free text went with the trade.
    const saved = await db.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, trade.id));
    expect(saved.map((a) => [a.role, a.cashHandedOver, a.note])).toEqual([["seller", true, null]]);
  });
});
