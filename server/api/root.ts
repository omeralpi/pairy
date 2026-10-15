import { authRouter } from "./routers/auth";
import { geoRouter } from "./routers/geo";
import { listingRouter } from "./routers/listing";
import { createTRPCRouter } from "./trpc";

export const appRouter = createTRPCRouter({
  auth: authRouter,
  geo: geoRouter,
  listing: listingRouter,
});

export type AppRouter = typeof appRouter;
