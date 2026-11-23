// SOW Deliverable 3 evidence: two trades opened at the same moment that
// together exceed a listing must not both be accepted. The listing offers
// 10 to 100 XLM; two buyers each open 60 at once, and exactly one may win.
//
// This file runs on pglite, which serialises transactions, so it can only
// check the rule (the remaining-amount check and its messages), never the
// listing row lock: a check with no lock passes here. The lock is the job of
// tests/pg/listing-reservation.pg.test.ts on real Postgres.
//
// Throwaway branch red/listing-reservation: the test is unmarked here so the
// listing-reservation-concurrency step goes red on today's code (the SOW's
// failing run). On phase2/track-b the same test is marked `it.fails` until
// WP-07 lands the remaining amount.

import { beforeEach, describe, expect, it } from "vitest";

import { tradeFixture } from "@/lib/trade/test-helpers";

let f: Awaited<ReturnType<typeof tradeFixture>>;

beforeEach(async () => {
  f = await tradeFixture();
});

function open(buyer: string, amount: string) {
  return f.as(buyer).trade.open({ listingId: f.listing.id, amount });
}

describe("listing-reservation-concurrency", () => {
  it("accepts only one of two simultaneous trades that together exceed the listing", async () => {
    const results = await Promise.allSettled([open(f.taker, "60"), open(f.stranger, "60")]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length, `${fulfilled.length} fulfilled, expected 1`).toBe(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toMatch(/Only 40 XLM left/);

    // What is left can still be taken, in full.
    const third = await open(f.stranger, "40");
    expect(third.state).toBe("listed");

    // Nothing left: refused with the minimum message, not the bounds one.
    await expect(open(f.taker, "10")).rejects.toThrow(/less than its minimum left/);
  });
});
