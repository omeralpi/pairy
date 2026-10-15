import { z } from "zod";

import { searchCities } from "@/lib/geo/cities";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";

export const geoRouter = createTRPCRouter({
  /** City picker. Returns names only: coordinates stay on the server. */
  searchCities: publicProcedure
    .input(z.object({ q: z.string().max(64) }))
    .query(({ input }) =>
      searchCities(input.q).map((c) => ({ id: c.id, name: c.name, region: c.region, countryCode: c.cc })),
    ),
});
