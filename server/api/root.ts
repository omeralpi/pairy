import { authRouter } from "./routers/auth";
import { chatRouter } from "./routers/chat";
import { geoRouter } from "./routers/geo";
import { listingRouter } from "./routers/listing";
import { tradeRouter } from "./routers/trade";
import { createTRPCRouter } from "./trpc";

export const appRouter = createTRPCRouter({
  auth: authRouter,
  geo: geoRouter,
  listing: listingRouter,
  trade: tradeRouter,
  chat: chatRouter,
});

export type AppRouter = typeof appRouter;
