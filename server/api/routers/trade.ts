import { NotFoundError } from "@stellar/stellar-sdk";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import { disputeAnswers, listings, tradeEvents, trades, users } from "@/lib/db/schema";
import { ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { FUNDED_NUDGE_MS, twViewerUrl } from "@/lib/escrow/config";
import { answerDeadline, promiseDeadline } from "@/lib/escrow/rule";
import { mayCancelProtected } from "@/lib/escrow/sync";
import { recomputeRemaining } from "@/lib/listing/remaining";
import { ASSETS } from "@/lib/stellar/assets";
import { CLAIM_WINDOW_SECONDS } from "@/lib/stellar/settlement";
import { explorerAccountUrl, explorerTxUrl, horizon, loadAccount } from "@/lib/stellar/horizon";
import { verifyClaimTx, verifyLockTx } from "@/lib/stellar/verify";
import { amountInput, fiatTotal, toStroops, trimAmount } from "@/lib/trade/amount";
import { claimWindow } from "@/lib/trade/claim-window";
import { tradeForParticipant, transitionTrade, type TradeRow } from "@/lib/trade/persist";
import { checkLock } from "@/lib/trade/preflight";
import { chain, expectedLock, findTradeLock, syncIfDue, syncTrade } from "@/lib/trade/sync";
import { TRADE_MODES, TradeStateMachine, type TradeRole } from "@/lib/trade/state-machine";
import { isArbiterSigner } from "@/server/api/arbiter-auth";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";

import { protectedModeOn } from "./escrow";

/**
 * Trades one account may have opened and not yet seen locked or ended. A
 * protected trade counts until its escrow is settled (O-24): created and
 * funded escrows are live commitments.
 */
const MAX_OPEN_TRADES = 5;

const tradeIdInput = z.object({ tradeId: z.string().uuid() });
const txInput = tradeIdInput.extend({
  txHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "Not a Stellar transaction hash").transform((h) => h.toLowerCase()),
});

/** A protected trade is accepted on the acceptance text both sides read (ACCEPTANCE_VERSION). */
const TEXT_CHANGED = "The protected-trade text changed. Read it again.";

/**
 * PLAN I13: an arbiter signer key is never a party to a protected trade. The
 * signer list is read live, and with no answer from Horizon there is no
 * protected trade.
 */
async function refuseArbiterSigners(keys: string[]): Promise<void> {
  let signer: boolean;
  try {
    signer = (await Promise.all(keys.map((k) => isArbiterSigner(k)))).some(Boolean);
  } catch (e) {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Couldn't check the arbiter account; try again.", cause: e });
  }
  if (signer) throw new TRPCError({ code: "BAD_REQUEST", message: "Arbiter signer keys can't trade in protected mode." });
}

function view(trade: TradeRow, me: string) {
  const role: TradeRole = trade.seller === me ? "seller" : "buyer";
  const counterparty = role === "seller" ? trade.buyer : trade.seller;
  return { ...trade, role, counterparty };
}

/**
 * A protected trade's dispute as both traders see it: each side's one answer
 * and its note (shown to both, MC-30), the 24 hours to answer from when Pairy
 * recorded the dispute (DECISIONS 1) and the arbiter's 72-hour promise.
 */
function disputeView(trade: TradeRow, answers: (typeof disputeAnswers.$inferSelect)[]) {
  const side = (role: TradeRole) => {
    const a = answers.find((x) => x.tradeId === trade.id && x.role === role);
    return a ? { cashHandedOver: a.cashHandedOver, note: a.note, answeredAt: a.answeredAt } : null;
  };
  return {
    answers: { seller: side("seller"), buyer: side("buyer") },
    answerDeadline: trade.disputeRecordedAt ? answerDeadline({ disputeRecordedAt: trade.disputeRecordedAt }) : null,
    promiseDeadline: trade.disputedAt ? promiseDeadline({ disputedAt: trade.disputedAt }) : null,
  };
}

export const tradeRouter = createTRPCRouter({
  open: protectedProcedure
    .input(
      z.object({
        listingId: z.string().uuid(),
        amount: amountInput,
        mode: z.enum(TRADE_MODES).default("claimable"),
        /** The acceptance text the opener accepted (ACCEPTANCE_VERSION); a protected trade needs it. */
        acceptanceVersion: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.publicKey;
      const amount = toStroops(input.amount);
      const isProtected = input.mode === "protected";
      if (isProtected) {
        // The kill switch stops new protected trades only (DECISIONS 6).
        if (!protectedModeOn()) throw new TRPCError({ code: "BAD_REQUEST", message: "Protected trades are switched off right now." });
        if (input.acceptanceVersion !== ACCEPTANCE_VERSION) throw new TRPCError({ code: "BAD_REQUEST", message: TEXT_CHANGED });
      }

      // Each agreed trade can be searched on Horizon by sync; one account
      // cannot hold an unbounded number of them open.
      const [{ open }] = await ctx.db
        .select({ open: count() })
        .from(trades)
        .where(
          and(
            or(
              and(eq(trades.seller, me), eq(trades.openedBy, "seller")),
              and(eq(trades.buyer, me), eq(trades.openedBy, "buyer")),
            ),
            inArray(trades.state, ["listed", "agreed", "escrow_created", "funded"]),
          ),
        );
      if (open >= MAX_OPEN_TRADES) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `You already have ${MAX_OPEN_TRADES} open trades that are not locked or settled yet. Finish or cancel one first.`,
        });
      }

      if (isProtected) {
        // Read before the listing lock, so no open waits on Horizon. A listing's owner never changes.
        const [owner] = await ctx.db.select({ key: listings.owner }).from(listings).where(eq(listings.id, input.listingId));
        await refuseArbiterSigners(owner ? [me, owner.key] : [me]);
      }

      await ctx.db.insert(users).values({ publicKey: me }).onConflictDoNothing();
      return ctx.db.transaction(async (tx) => {
        // The listing row lock holds every other open and every transition on
        // this listing until this one commits, so what is left is checked and
        // reserved as one step (lock order everywhere: listing, then trade).
        const [listing] = await tx.select().from(listings).where(eq(listings.id, input.listingId)).for("update");
        if (!listing || listing.status !== "active") {
          throw new TRPCError({ code: "NOT_FOUND", message: "This listing is not available" });
        }
        if (listing.owner === me) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot trade on your own listing" });
        }
        if (isProtected && !ASSETS[listing.asset].protectedMode) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Protected trades work with USDC only for now." });
        }
        if (amount < toStroops(listing.minAmount) || amount > toStroops(listing.maxAmount)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Amount must be between ${trimAmount(listing.minAmount)} and ${trimAmount(listing.maxAmount)} ${listing.asset}`,
          });
        }
        const left = toStroops(listing.remainingAmount);
        if (left < toStroops(listing.minAmount)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This listing has less than its minimum left, so it isn't taking trades right now.",
          });
        }
        if (amount > left) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Only ${trimAmount(listing.remainingAmount)} ${listing.asset} left on this listing. Enter ${trimAmount(listing.minAmount)} to ${trimAmount(listing.remainingAmount)}.`,
          });
        }

        const fiatAmount = fiatTotal(input.amount, listing.rate);
        if (fiatAmount === "0.00") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `At this rate the cash side must be at least 0.01 ${listing.fiatCode}; enter a larger amount`,
          });
        }

        // sell_crypto: the owner holds the crypto, so the owner is the seller.
        const ownerIsSeller = listing.side === "sell_crypto";
        const openedBy: TradeRole = ownerIsSeller ? "buyer" : "seller";
        const { snapshot } = TradeStateMachine.open(openedBy, input.mode);
        const now = new Date();

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
            fiatAmount,
            // A protected trade settles through its escrow, which has no claim window.
            windowSeconds: isProtected ? 0 : CLAIM_WINDOW_SECONDS,
            // The opener accepts the protected-trade text by opening; the other side at agree.
            acceptanceVersion: isProtected ? ACCEPTANCE_VERSION : null,
            sellerAcceptedAt: isProtected && openedBy === "seller" ? now : null,
            buyerAcceptedAt: isProtected && openedBy === "buyer" ? now : null,
          })
          .returning();
        await tx.insert(tradeEvents).values({ tradeId: trade.id, type: "open", by: openedBy });
        await recomputeRemaining(tx, listing.id);
        return trade;
      });
    }),

  agree: protectedProcedure
    .input(tradeIdInput.extend({ acceptanceVersion: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { trade, role } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
      if (trade.mode !== "protected") return transitionTrade(ctx.db, input.tradeId, { type: "agree", by: role });
      // Allowed with PROTECTED_MODE off: an open protected trade goes on. Both sides accept the same text.
      if (input.acceptanceVersion !== ACCEPTANCE_VERSION || trade.acceptanceVersion !== ACCEPTANCE_VERSION) {
        throw new TRPCError({ code: "BAD_REQUEST", message: TEXT_CHANGED });
      }
      await refuseArbiterSigners([ctx.session.publicKey]);
      return transitionTrade(ctx.db, input.tradeId, { type: "agree", by: role, acceptedAt: new Date() });
    }),

  cancel: protectedProcedure.input(tradeIdInput).mutation(async ({ ctx, input }) => {
    const { trade, role } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    if (trade.mode === "protected") {
      // The escrow is checked on chain first: a landed creation or fund is
      // recorded, and a funded escrow is never cancelled (D2 §1.1, O-23).
      await mayCancelProtected(ctx.db, trade);
    } else if (trade.state === "agreed" && (await syncTrade(ctx.db, trade)).state !== "agreed") {
      // The seller may already have locked on-chain while the record is in
      // flight; cancelling then would leave a live lock the app calls cancelled.
      // Record that lock instead and refuse.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "The seller has already locked this trade on Stellar, so it can't be cancelled. The buyer can claim it, or the seller takes it back after the window.",
      });
    }
    return transitionTrade(ctx.db, input.tradeId, { type: "cancel", by: role });
  }),

  /** Records the flag and nothing else: the Phase 2 arbiter hook. */
  flagDispute: protectedProcedure.input(tradeIdInput).mutation(async ({ ctx, input }) => {
    const { trade, role } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    if (trade.mode === "protected") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "In a protected trade, Flag a problem opens a dispute on the escrow." });
    }
    return transitionTrade(ctx.db, input.tradeId, { type: "flagDispute", by: role });
  }),

  lockPreflight: protectedProcedure.input(tradeIdInput).query(async ({ ctx, input }) => {
    const { trade } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    if (trade.mode === "protected") {
      throw new TRPCError({ code: "BAD_REQUEST", message: "A protected trade has no lock; its escrow has checks of its own." });
    }
    // A lock the full search finds is recorded (balanceId). When that search
    // ran too recently, one live-balance query still catches a lock that
    // landed since: this check is what stands between the seller and a
    // second lock.
    const existingLock = async () => {
      if (trade.balanceId) return true;
      const synced = await syncIfDue(ctx.db, trade);
      if (synced) return synced.balanceId !== null;
      return (await findTradeLock(ctx.db, trade, { liveOnly: true })) !== null;
    };
    const [seller, buyer, locked] = await Promise.all([
      loadAccount(trade.seller),
      loadAccount(trade.buyer),
      existingLock(),
    ]);
    return checkLock({ asset: trade.asset, amount: trade.amount, seller, buyer, existingLock: locked });
  }),

  recordLock: protectedProcedure.input(txInput).mutation(async ({ ctx, input }) => {
    const { trade } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    const expected = await expectedLock(ctx.db, trade);
    if (!expected) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          trade.state === "cancelled"
            ? "A lock can't be recorded on this cancelled trade. If it was made for another open trade with the same terms, record it there."
            : "only an agreed trade can be locked",
      });
    }
    const { balanceId, createdAt } = await chain(verifyLockTx(input.txHash, expected));
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
      lockedAt: createdAt,
      // A lock that lands after a cancel is still the seller's money on the
      // ledger, so it is recorded rather than refused.
      reconcile: trade.state === "cancelled",
    });
  }),

  /** Records any lock or claim on the ledger that the app missed. */
  sync: protectedProcedure.input(tradeIdInput).mutation(async ({ ctx, input }) => {
    const { trade } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    return (await syncIfDue(ctx.db, trade)) ?? trade;
  }),

  /** Either party may report it; the chain says who claimed, not the reporter. */
  recordClaim: protectedProcedure.input(txInput).mutation(async ({ ctx, input }) => {
    const { trade } = await tradeForParticipant(ctx.db, input.tradeId, ctx.session.publicKey);
    if (!trade.balanceId) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "This trade has not been locked" });
    }
    const { claimant } = await chain(verifyClaimTx(input.txHash, trade.balanceId));
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
    // serverNow lets the client correct its countdown for a wrong device clock.
    return { ...claimWindow(record.claimants, trade.buyer, trade.seller), serverNow: Date.now() };
  }),

  mine: protectedProcedure.query(async ({ ctx }) => {
    const me = ctx.session.publicKey;
    const answers = await ctx.db
      .select({ answer: disputeAnswers })
      .from(disputeAnswers)
      .innerJoin(trades, eq(trades.id, disputeAnswers.tradeId))
      .where(or(eq(trades.seller, me), eq(trades.buyer, me)));
    const rows = await ctx.db
      .select({
        trade: trades,
        cityName: listings.cityName,
        // A trade is locked at most once, so this is the one lock event.
        // The ledger time when known; for older rows, when Pairy recorded the lock.
        lockedAt: sql`coalesce(${trades.lockedAt}, (select ${tradeEvents.createdAt} from ${tradeEvents} where ${tradeEvents.tradeId} = ${trades.id} and ${tradeEvents.type} = 'lock' limit 1))`.mapWith(trades.lockedAt),
      })
      .from(trades)
      .innerJoin(listings, eq(listings.id, trades.listingId))
      .where(or(eq(trades.seller, me), eq(trades.buyer, me)))
      .orderBy(desc(trades.updatedAt));
    return rows.map((r) => ({
      ...view(r.trade, me),
      ...disputeView(r.trade, answers.map((a) => a.answer)),
      cityName: r.cityName,
      lockedAt: r.lockedAt as Date | null,
    }));
  }),

  byId: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const me = ctx.session.publicKey;
    const { trade } = await tradeForParticipant(ctx.db, input.id, me);
    const [[listing], events, answers] = await Promise.all([
      ctx.db
        .select({ cityName: listings.cityName, countryCode: listings.countryCode, rate: listings.rate })
        .from(listings)
        .where(eq(listings.id, trade.listingId)),
      ctx.db
        .select()
        .from(tradeEvents)
        .where(eq(tradeEvents.tradeId, trade.id))
        .orderBy(asc(tradeEvents.createdAt)),
      ctx.db.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, trade.id)),
    ]);
    const v = view(trade, me);
    return {
      ...v,
      ...disputeView(trade, answers),
      cityName: listing.cityName,
      countryCode: listing.countryCode,
      // Listings' rates never change, so this is the rate the trade was priced at.
      rate: listing.rate,
      counterpartyUrl: explorerAccountUrl(v.counterparty),
      events: events.map((e) => ({ ...e, txUrl: e.txHash ? explorerTxUrl(e.txHash) : null })),
      // Protected trades: the escrow on Trustless Work's viewer once it exists (G3), and a nudge once a
      // funded trade has had no release or dispute for 72 h.
      viewerUrl: trade.createTx !== null && trade.escrowContractId !== null ? twViewerUrl(trade.escrowContractId) : null,
      stallNudge:
        trade.state === "funded" && !trade.disputed && trade.fundedAt !== null && Date.now() >= trade.fundedAt.getTime() + FUNDED_NUDGE_MS,
    };
  }),
});
