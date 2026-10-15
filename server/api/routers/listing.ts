import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { listings, users } from "@/lib/db/schema";
import { FIAT_CODES } from "@/lib/fiat";
import { cityById } from "@/lib/geo/cities";
import { ASSET_CODES } from "@/lib/stellar/assets";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "@/server/api/trpc";

// Stellar amounts carry at most 7 decimals; 13 integer digits fits numeric(20, 7).
const amount = z
  .string()
  .regex(/^\d{1,13}(\.\d{1,7})?$/, "Amount must be a number with at most 7 decimals")
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

// numeric(20, 4)
const rate = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,4})?$/, "Rate must be a number with at most 4 decimals")
  .refine((v) => Number(v) > 0, "Rate must be greater than zero");

/** Exact decimal → integer stroops, so min ≤ max is compared without float rounding. */
function toStroops(v: string): bigint {
  const [int, frac = ""] = v.split(".");
  return BigInt(int + frac.padEnd(7, "0"));
}

const createInput = z
  .object({
    side: z.enum(["sell_crypto", "buy_crypto"]),
    asset: z.enum(ASSET_CODES),
    minAmount: amount,
    maxAmount: amount,
    fiatCode: z.enum(FIAT_CODES),
    rate,
    // Only a city id: the server looks up the coordinates in its own table.
    cityId: z.string().regex(/^\d{1,12}$/),
    note: z.string().trim().max(280).optional(),
  })
  .strict()
  .refine((v) => toStroops(v.minAmount) <= toStroops(v.maxAmount), {
    message: "Minimum must not exceed maximum",
    path: ["minAmount"],
  });

const lng = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);

const listInput = z
  .object({
    asset: z.enum(ASSET_CODES).optional(),
    side: z.enum(["sell_crypto", "buy_crypto"]).optional(),
    fiatCode: z.enum(FIAT_CODES).optional(),
    bbox: z.object({ west: lng, south: lat, east: lng, north: lat }).optional(),
  })
  .optional();

// Every column a client may see. The owner is a Stellar public key and that is
// the only thing about a person Pairy has.
const publicColumns = {
  id: listings.id,
  owner: listings.owner,
  side: listings.side,
  asset: listings.asset,
  minAmount: listings.minAmount,
  maxAmount: listings.maxAmount,
  fiatCode: listings.fiatCode,
  rate: listings.rate,
  cityId: listings.cityId,
  cityName: listings.cityName,
  countryCode: listings.countryCode,
  latitude: listings.latitude,
  longitude: listings.longitude,
  note: listings.note,
  status: listings.status,
  createdAt: listings.createdAt,
};

type PublicRow = { [K in keyof typeof publicColumns]: (typeof listings.$inferSelect)[K] };

/** Copies only the public columns, so a full row from returning() cannot leak extra fields. */
function toPublic(r: PublicRow) {
  const out = {} as PublicRow;
  for (const k of Object.keys(publicColumns) as (keyof PublicRow)[]) (out as Record<string, unknown>)[k] = r[k];
  return { ...out, latitude: Number(r.latitude), longitude: Number(r.longitude) };
}

export const listingRouter = createTRPCRouter({
  create: protectedProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    const city = cityById(input.cityId);
    if (!city) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown city" });
    const owner = ctx.session.publicKey;
    await ctx.db.insert(users).values({ publicKey: owner }).onConflictDoNothing();
    const [row] = await ctx.db
      .insert(listings)
      .values({
        owner,
        side: input.side,
        asset: input.asset,
        minAmount: input.minAmount,
        maxAmount: input.maxAmount,
        fiatCode: input.fiatCode,
        rate: input.rate,
        cityId: city.id,
        cityName: city.name,
        countryCode: city.cc,
        latitude: String(city.lat),
        longitude: String(city.lng),
        note: input.note || null,
      })
      .returning();
    return toPublic(row);
  }),

  /** Active listings, newest first. */
  list: publicProcedure.input(listInput).query(async ({ ctx, input }) => {
    const where: (SQL | undefined)[] = [eq(listings.status, "active")];
    if (input?.asset) where.push(eq(listings.asset, input.asset));
    if (input?.side) where.push(eq(listings.side, input.side));
    if (input?.fiatCode) where.push(eq(listings.fiatCode, input.fiatCode));
    if (input?.bbox) {
      const { west, south, east, north } = input.bbox;
      where.push(gte(listings.latitude, String(south)), lte(listings.latitude, String(north)));
      // A box that crosses the antimeridian has west > east.
      where.push(
        west <= east
          ? and(gte(listings.longitude, String(west)), lte(listings.longitude, String(east)))
          : or(gte(listings.longitude, String(west)), lte(listings.longitude, String(east))),
      );
    }
    const rows = await ctx.db
      .select(publicColumns)
      .from(listings)
      .where(and(...where))
      .orderBy(desc(listings.createdAt))
      .limit(500);
    return rows.map(toPublic);
  }),

  byId: publicProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const [row] = await ctx.db.select(publicColumns).from(listings).where(eq(listings.id, input.id));
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return toPublic(row);
  }),

  mine: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select(publicColumns)
      .from(listings)
      .where(eq(listings.owner, ctx.session.publicKey))
      .orderBy(sql`${listings.status} = 'closed'`, desc(listings.createdAt));
    return rows.map(toPublic);
  }),

  setStatus: protectedProcedure
    .input(z.object({ id: z.string().uuid(), status: z.enum(["active", "paused", "closed"]) }))
    .mutation(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({ owner: listings.owner, status: listings.status })
        .from(listings)
        .where(eq(listings.id, input.id));
      if (!row) throw new TRPCError({ code: "NOT_FOUND" });
      if (row.owner !== ctx.session.publicKey) throw new TRPCError({ code: "FORBIDDEN" });
      // Closed is final, so a closed listing never resurfaces under trades that referenced it.
      if (row.status === "closed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A closed listing cannot be reopened" });
      }
      const [updated] = await ctx.db
        .update(listings)
        .set({ status: input.status })
        .where(eq(listings.id, input.id))
        .returning();
      return toPublic(updated);
    }),
});
