import { NotFoundError } from "@stellar/stellar-sdk";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, ne, or } from "drizzle-orm";
import { z } from "zod";

import { listings, tradeEvents, trades, users } from "@/lib/db/schema";
import { CLAIM_WINDOW_SECONDS } from "@/lib/stellar/settlement";
import { explorerAccountUrl, explorerTxUrl, horizon, loadAccount } from "@/lib/stellar/horizon";
import { verifyClaimTx, verifyLockTx } from "@/lib/stellar/verify";
import { amountInput, fiatTotal, toStroops, trimAmount } from "@/lib/trade/amount";
import { claimWindow } from "@/lib/trade/claim-window";
import { tradeForParticipant, transitionTrade, type TradeRow } from "@/lib/trade/persist";
import { checkLock } from "@/lib/trade/preflight";
import { TradeStateMachine, type TradeRole } from "@/lib/trade/state-machine";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";

const tradeIdInput = z.object({ tradeId: z.string().uuid() });
const txInput = tradeIdInput.extend({
  txHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "Not a Stellar transaction hash").transform((h) => h.toLowerCase()),
});

/** Horizon/verify failures become a readable BAD_REQUEST instead of a 500. */
async function verified<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: e instanceof Error ? e.message : "The transaction could not be verified",
      cause: e,
    });
  }
}

function view(trade: TradeRow, me: string) {
  const role: TradeRole = trade.seller === me ? "seller" : "buyer";
  const counterparty = role === "seller" ? trade.buyer : trade.seller;
  return { ...trade, role, counterparty };
}

export const tradeRouter = createTRPCRouter({
  open: protectedProcedure
    .input(z.object({ listingId: z.string().uuid(), amount: amountInput }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.publicKey;
      const [listing] = await ctx.db.select().from(listings).where(eq(listings.id, input.listingId));
      if (!listing || listing.status !== "active") {
        throw new TRPCError({ code: "NOT_FOUND", message: "This listing is not available" });
      }
      if (listing.owner === me) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot trade on your own listing" });
      }
      const amount = toStroops(input.amount);
      if (amount < toStroops(listing.minAmount) || amount > toStroops(listing.maxAmount)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Amount must be between ${trimAmount(listing.minAmount)} and ${trimAmount(listing.maxAmount)} ${listing.asset}`,
        });
      }

      // sell_crypto: the owner holds the crypto, so the owner is the seller.
      const ownerIsSeller = listing.side === "sell_crypto";
      const openedBy: TradeRole = ownerIsSeller ? "buyer" : "seller";
      const { snapshot } = TradeStateMachine.open(openedBy);

      await ctx.db.insert(users).values({ publicKey: me }).onConflictDoNothing();
      return ctx.db.transaction(async (tx) => {
        const [trade] = await tx
          .insert(trades)
          .values({
            ...snapshot,
            listingId: listing.id,
            seller: ownerIsSeller ? listing.owner : me,
            buyer: ownerIsSeller ? me : listing.owner,
            asset: listing.asset,
            amount: input.amount,
            fiatCode: listing.fiatCode,
            fiatAmount: fiatTotal(input.amount, listing.rate),
            windowSeconds: CLAIM_WINDOW_SECONDS,
          })
          .returning();
        await tx.insert(tradeEvents).values({ tradeId: trade.id, type: "open", by: openedBy });
        return trade;
      });
    }),

  agree: protectedProcedure.input(tradeIdInput).mutation(async ({ ctx, input }) => {
    const { role } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    return transitionTrade(ctx.db, input.tradeId, { type: "agree", by: role });
  }),

  cancel: protectedProcedure.input(tradeIdInput).mutation(async ({ ctx, input }) => {
    const { role } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    return transitionTrade(ctx.db, input.tradeId, { type: "cancel", by: role });
  }),

  /** Records the flag and nothing else: the Phase 2 arbiter hook. */
  flagDispute: protectedProcedure.input(tradeIdInput).mutation(async ({ ctx, input }) => {
    const { role } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    return transitionTrade(ctx.db, input.tradeId, { type: "flagDispute", by: role });
  }),

  lockPreflight: protectedProcedure.input(tradeIdInput).query(async ({ ctx, input }) => {
    const { trade } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    const [seller, buyer] = await Promise.all([loadAccount(trade.seller), loadAccount(trade.buyer)]);
    return checkLock({ asset: trade.asset, amount: trade.amount, seller, buyer });
  }),

  recordLock: protectedProcedure.input(txInput).mutation(async ({ ctx, input }) => {
    const { trade } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    const { balanceId } = await verified(
      verifyLockTx(input.txHash, {
        seller: trade.seller,
        buyer: trade.buyer,
        asset: trade.asset,
        amount: trade.amount,
        windowSeconds: trade.windowSeconds,
      }),
    );
    // One on-chain lock backs one trade: the same parties and amount on a
    // second trade must not be able to reuse it.
    const [other] = await ctx.db
      .select({ id: trades.id })
      .from(trades)
      .where(and(eq(trades.balanceId, balanceId), ne(trades.id, trade.id)));
    if (other) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "That lock already belongs to another trade" });
    }
    return transitionTrade(ctx.db, trade.id, {
      type: "lock",
      by: "seller",
      balanceId,
      txHash: input.txHash,
    });
  }),

  /** Either party may report it; the chain says who claimed, not the reporter. */
  recordClaim: protectedProcedure.input(txInput).mutation(async ({ ctx, input }) => {
    const { trade } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    if (!trade.balanceId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This trade has not been locked" });
    }
    const { claimant } = await verified(verifyClaimTx(input.txHash, trade.balanceId));
    if (claimant === trade.buyer) {
      return transitionTrade(ctx.db, trade.id, { type: "claim", by: "buyer", txHash: input.txHash });
    }
    if (claimant === trade.seller) {
      return transitionTrade(ctx.db, trade.id, { type: "reclaim", by: "seller", txHash: input.txHash });
    }
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "That claim was made by an account that is not part of this trade",
    });
  }),

  /** Countdown data for a locked trade, from the live claimable-balance record. */
  claimWindow: protectedProcedure.input(tradeIdInput).query(async ({ ctx, input }) => {
    const { trade } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    if (trade.state !== "locked" || !trade.balanceId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This trade is not locked" });
    }
    const record = await horizon
      .claimableBalances()
      .claimableBalance(trade.balanceId)
      .call()
      .catch((e) => {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            e instanceof NotFoundError
              ? "The locked balance is no longer on the ledger, so it has probably just been claimed. This page updates once the claim is recorded."
              : "Could not read the locked balance from Stellar testnet",
          cause: e,
        });
      });
    return claimWindow(record.claimants, trade.buyer, trade.seller);
  }),

  mine: protectedProcedure.query(async ({ ctx }) => {
    const me = ctx.session.publicKey;
    const rows = await ctx.db
      .select({ trade: trades, cityName: listings.cityName })
      .from(trades)
      .innerJoin(listings, eq(listings.id, trades.listingId))
      .where(or(eq(trades.seller, me), eq(trades.buyer, me)))
      .orderBy(desc(trades.updatedAt));
    return rows.map((r) => ({ ...view(r.trade, me), cityName: r.cityName }));
  }),

  byId: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const me = ctx.session.publicKey;
    const { trade } = await tradeForParticipant(ctx.db, input.id, me);
    const [[listing], events] = await Promise.all([
      ctx.db
        .select({ cityName: listings.cityName, countryCode: listings.countryCode })
        .from(listings)
        .where(eq(listings.id, trade.listingId)),
      ctx.db
        .select()
        .from(tradeEvents)
        .where(eq(tradeEvents.tradeId, trade.id))
        .orderBy(asc(tradeEvents.createdAt)),
    ]);
    const v = view(trade, me);
    return {
      ...v,
      cityName: listing.cityName,
      countryCode: listing.countryCode,
      counterpartyUrl: explorerAccountUrl(v.counterparty),
      events: events.map((e) => ({ ...e, txUrl: e.txHash ? explorerTxUrl(e.txHash) : null })),
    };
  }),
});
