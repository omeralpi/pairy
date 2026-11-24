import { authRouter } from "./routers/auth";
import { chatRouter } from "./routers/chat";
import { escrowRouter } from "./routers/escrow";
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
  escrow: escrowRouter,
});

export type AppRouter = typeof appRouter;
