import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { listings } from "@/lib/db/schema";
import { createTestDb, type TestDb } from "@/lib/db/test-setup";
import { cityById } from "@/lib/geo/cities";
import { createCallerFactory } from "@/server/api/trpc";

import { listingRouter } from "./listing";

const ALICE = "GALICEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const BOB = "GBOBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const ISTANBUL = "745044";
const LAGOS = "2332459";

const createCaller = createCallerFactory(listingRouter);
let db: TestDb;
const as = (publicKey: string | null) =>
  createCaller({ db, session: publicKey ? { publicKey } : null, resHeaders: new Headers() });

const valid = {
  side: "sell_crypto",
  asset: "USDC",
  minAmount: "10",
  maxAmount: "250.5",
  fiatCode: "TRY",
  rate: "41.25",
  cityId: ISTANBUL,
} as const;

beforeEach(async () => {
  ({ db } = await createTestDb());
});

async function rejects(p: Promise<unknown>, code: TRPCError["code"]) {
  await expect(p).rejects.toMatchObject({ code });
}

describe("listing.create", () => {
  it("places the listing at the server's city centroid", async () => {
    const city = cityById(ISTANBUL)!;
    const created = await as(ALICE).create(valid);
    expect(created).toMatchObject({
      owner: ALICE,
      cityName: city.name,
      countryCode: "TR",
      latitude: city.lat,
      longitude: city.lng,
      minAmount: "10.0000000",
      status: "active",
    });
  });

  it("refuses client-supplied coordinates instead of ignoring them", async () => {
    await rejects(as(ALICE).create({ ...valid, latitude: 1.23456, longitude: 2.34567 } as never), "BAD_REQUEST");
    expect(await db.select().from(listings)).toHaveLength(0);
  });

  it("rejects an unknown city", async () => {
    await rejects(as(ALICE).create({ ...valid, cityId: "999999999" }), "BAD_REQUEST");
  });

  it("requires a session", async () => {
    await rejects(as(null).create(valid), "UNAUTHORIZED");
  });

  it.each([
    ["more than 7 decimals", { minAmount: "1.12345678" }],
    ["zero", { minAmount: "0" }],
    ["negative", { minAmount: "-1" }],
    ["not a number", { maxAmount: "1e5" }],
    ["min above max", { minAmount: "300", maxAmount: "250.5" }],
    ["min above max by one stroop", { minAmount: "1.0000001", maxAmount: "1" }],
    ["unknown fiat", { fiatCode: "XXX" }],
    ["unsupported asset", { asset: "BTC" }],
    ["rate with 5 decimals", { rate: "1.12345" }],
    ["note over 280 chars", { note: "x".repeat(281) }],
  ])("rejects %s", async (_label, patch) => {
    await rejects(as(ALICE).create({ ...valid, ...patch } as never), "BAD_REQUEST");
  });

  it("accepts min equal to max with 7 decimals", async () => {
    const created = await as(ALICE).create({ ...valid, minAmount: "1.0000001", maxAmount: "1.0000001" });
    expect(created.maxAmount).toBe("1.0000001");
  });
});

describe("listing.list", () => {
  beforeEach(async () => {
    await as(ALICE).create(valid);
    await as(BOB).create({ ...valid, side: "buy_crypto", asset: "XLM", fiatCode: "NGN", cityId: LAGOS });
  });

  it("filters by asset, side and fiat", async () => {
    expect(await as(null).list()).toHaveLength(2);
    expect((await as(null).list({ asset: "XLM" })).map((l) => l.owner)).toEqual([BOB]);
    expect((await as(null).list({ side: "sell_crypto" })).map((l) => l.owner)).toEqual([ALICE]);
    expect(await as(null).list({ fiatCode: "EUR" })).toHaveLength(0);
  });

  it("filters by map bbox", async () => {
    const turkey = { west: 26, south: 36, east: 45, north: 42 };
    expect((await as(null).list({ bbox: turkey })).map((l) => l.cityId)).toEqual([ISTANBUL]);
    // Crosses the antimeridian: from 170°E east to 30°E, which covers both.
    expect(await as(null).list({ bbox: { west: 170, south: -60, east: 30, north: 60 } })).toHaveLength(2);
  });

  it("hides paused and closed listings", async () => {
    const [mine] = await as(ALICE).mine();
    await as(ALICE).setStatus({ id: mine.id, status: "paused" });
    expect((await as(null).list()).map((l) => l.owner)).toEqual([BOB]);
  });
});

describe("listing.setStatus", () => {
  it("is owner-only", async () => {
    const created = await as(ALICE).create(valid);
    await rejects(as(BOB).setStatus({ id: created.id, status: "closed" }), "FORBIDDEN");
    await rejects(as(null).setStatus({ id: created.id, status: "closed" }), "UNAUTHORIZED");
    const [row] = await db.select().from(listings).where(eq(listings.id, created.id));
    expect(row.status).toBe("active");
  });

  it("pauses, resumes and closes for good", async () => {
    const { id } = await as(ALICE).create(valid);
    expect((await as(ALICE).setStatus({ id, status: "paused" })).status).toBe("paused");
    expect((await as(ALICE).setStatus({ id, status: "active" })).status).toBe("active");
    expect((await as(ALICE).setStatus({ id, status: "closed" })).status).toBe("closed");
    await rejects(as(ALICE).setStatus({ id, status: "active" }), "BAD_REQUEST");
  });

  it("404s on an unknown listing", async () => {
    await rejects(
      as(ALICE).setStatus({ id: "00000000-0000-0000-0000-000000000000", status: "paused" }),
      "NOT_FOUND",
    );
  });
});

describe("listing.byId / mine", () => {
  it("returns only public keys about people", async () => {
    const { id } = await as(ALICE).create({ ...valid, note: "Near the ferry, weekdays" });
    const got = await as(null).byId({ id });
    expect(Object.keys(got).sort()).toEqual(
      [
        "asset", "cityId", "cityName", "countryCode", "createdAt", "fiatCode", "id", "latitude",
        "longitude", "maxAmount", "minAmount", "note", "owner", "rate", "side", "status",
      ].sort(),
    );
    expect((await as(ALICE).mine()).map((l) => l.id)).toEqual([id]);
    expect(await as(BOB).mine()).toHaveLength(0);
  });
});
