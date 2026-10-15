import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { chatMessages, trades } from "@/lib/db/schema";
import { tradeForParticipant } from "@/lib/trade/persist";
import { isTerminal } from "@/lib/trade/state-machine";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";

const columns = {
  id: chatMessages.id,
  author: chatMessages.author,
  body: chatMessages.body,
  createdAt: chatMessages.createdAt,
};

// Per-deal chat, scoped to one trade and deleted when it reaches a terminal
// state (see lib/trade/persist.ts). Clients poll `list` every 3 s.
export const chatRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ tradeId: z.string().uuid(), after: z.date().optional() }))
    .query(async ({ ctx, input }) => {
      await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
      return ctx.db
        .select(columns)
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.tradeId, input.tradeId),
            input.after ? gt(chatMessages.createdAt, input.after) : undefined,
          ),
        )
        .orderBy(asc(chatMessages.createdAt));
    }),

  send: protectedProcedure
    .input(z.object({ tradeId: z.string().uuid(), body: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.publicKey;
      await tradeForParticipant(ctx.db, input.tradeId, me);
      return ctx.db.transaction(async (tx) => {
        // FOR SHARE blocks a concurrent terminal transition until this insert
        // commits (its purge then sees and deletes it), and makes this read
        // wait for one already in flight.
        const [trade] = await tx
          .select({ state: trades.state })
          .from(trades)
          .where(eq(trades.id, input.tradeId))
          .for("share");
        if (isTerminal(trade.state)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "This trade has ended, so its chat is closed" });
        }
        // returning() without a field map: the Db | TestDb union loses that overload.
        const [{ id, author, body, createdAt }] = await tx
          .insert(chatMessages)
          .values({ tradeId: input.tradeId, author: me, body: input.body })
          .returning();
        return { id, author, body, createdAt };
      });
    }),
});
