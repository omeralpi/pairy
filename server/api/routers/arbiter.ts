// The arbiter router (D2 §5.3): the arbiter account's signers see the open
// disputes, prepare the one resolution the published rule gives, and collect
// their signatures on it.
//
// Pairy's server never signs and never submits (PLAN I1, I3). Trustless Work
// prepares the resolve from the trade's row, its two answers and the escrow's
// USDC balance on chain; no address, amount or outcome comes from the caller
// (PLAN I8). The server checks it (DECISIONS 7), re-times only its maxTime so
// two people on two computers have an hour to sign (O-17), checks that
// nothing else changed, and checks it again as the browser will. Each signer
// signs that transaction in Freighter on their own computer; the server checks
// each signature against its hash and merges them, and the last signer's
// browser sends the result to Horizon. The trade is recorded only once Horizon
// shows the resolve (PLAN I9).
//
// One resolution is signed at a time across all trades (FIXES F-03): every
// prepared resolve uses the arbiter account's next sequence number, so only
// one of them could ever land.

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { arbiterResolutions, disputeAnswers, trades } from "@/lib/db/schema";
import { ARBITER_ACCOUNT, RESOLVE_WINDOW_SECONDS, TW_ESCROW_WASM_HASH, TW_FEE_ADDRESS, twViewerUrl } from "@/lib/escrow/config";
import { describeEscrowError } from "@/lib/escrow/errors";
import { extractSignatures, mergeSignatures, type ArbiterSignature } from "@/lib/escrow/multisig";
import { readCodeTtl, readEscrow, type EscrowTtl } from "@/lib/escrow/read";
import { answerDeadline, promiseDeadline, resolutionReady, ruleOutcome, type Answer } from "@/lib/escrow/rule";
import { findEscrowTx, verifyEscrowTx } from "@/lib/escrow/verify";
import { decodeEscrowCall, describeEscrowCall, onlyMaxTimeChanged, rebuildMaxTime, validateEscrowCall, type CallExpectation } from "@/lib/escrow/xdr";
import { explorerTxUrl, networkDeadline } from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { fromStroops, toStroops } from "@/lib/trade/amount";
import { transitionTrade, type Database, type TradeRow } from "@/lib/trade/persist";
import type { TradeRole } from "@/lib/trade/state-machine";
import { chain } from "@/lib/trade/sync";
import {
  arbiterAccountNow,
  arbiterAccountProblems,
  arbiterAccountState,
  arbiterProcedure,
  type ArbiterAccountState,
} from "@/server/api/arbiter-auth";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { TwApiError, twAmount, twCall, type TwInput, type TwOutput } from "@/server/tw/client";

type Resolution = typeof arbiterResolutions.$inferSelect;
type AnswerRow = { tradeId: string; role: TradeRole; cashHandedOver: boolean };

const tradeIdInput = z.object({ tradeId: z.string().uuid() });

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

/** docs/arbitration.md, "The rule": one sentence per rule. */
const RULE_SENTENCE = {
  1: "If the seller answers yes, the buyer is paid.",
  2: "Otherwise, if the seller sent no answer and the buyer answers yes, the buyer is paid.",
  3: "In every other case the seller gets the USDC back.",
} as const;

/** F-11: a resolution stored without an expiry expires 10 minutes after it was made. */
const NO_EXPIRY_MS = 10 * 60_000;
/** Ledgers close about every 5 s: the signing window in ledgers, and a minute's slack (O-17). */
const WINDOW_LEDGERS = Math.ceil(RESOLVE_WINDOW_SECONDS / 5) + 60;
/** The escrow contract extends its ["Escrow"] entry once fewer ledgers than this are left (WP-14). */
const EXTEND_BELOW_LEDGERS = 17_280;
/** A resolve carrying every signature is under 2 KB of XDR. */
const SIGNED_XDR_MAX = 20_000;

const TW_REFUSED = "Trustless Work returned a resolution Pairy won't ask the signers to sign";
const REBUILT_REFUSED = "The re-timed resolution fails Pairy's check";
const CLOSED = {
  expired: "This prepared transaction expired. Prepare again.",
  failed: "This prepared transaction was not accepted by the network; prepare again.",
  submitted: "This resolution was already sent.",
} as const;

/** Horizon or Soroban RPC not answering: nothing was prepared or changed. */
async function network<T>(p: Promise<T>, message: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message, cause: e });
  }
}
const arbiterNow = () => network(arbiterAccountNow(), "Couldn't read the arbiter account from Horizon; try again in a minute.");

/** The signatures the arbiter account needs on a resolve: its source account's medium threshold, at least its low one. */
const thresholdOf = (s: ArbiterAccountState) => Math.max(s.thresholds.low, s.thresholds.med);
const weightOf = (signers: string[], s: ArbiterAccountState) =>
  signers.reduce((w, key) => w + (s.signers.find((x) => x.key === key)?.weight ?? 0), 0);

const expiryOf = (r: Resolution) => r.expiresAt ?? new Date(r.createdAt.getTime() + NO_EXPIRY_MS);
const sequenceOf = (unsignedXdr: string) => BigInt((TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE) as Transaction).sequence);

/** Why a collecting resolution can no longer land, or null: its window closed, or the arbiter's sequence moved past it (FIXES F-03). */
function staleness(r: Resolution, arbiterSequence: string): string | null {
  const expires = expiryOf(r);
  if (expires.getTime() <= Date.now()) return `This prepared transaction expired at ${expires.toISOString()}. Prepare again.`;
  if (sequenceOf(r.unsignedXdr) !== BigInt(arbiterSequence) + 1n) return "The arbiter account moved on; prepare again.";
  return null;
}

async function close(db: Database, id: string, status: "expired" | "failed") {
  await db
    .update(arbiterResolutions)
    .set({ status })
    .where(and(eq(arbiterResolutions.id, id), eq(arbiterResolutions.status, "collecting")));
}

const inAbout = (ledgers: number) => {
  const minutes = Math.ceil((ledgers * 5) / 60);
  return minutes <= 1 ? "a minute" : `${minutes} minutes`;
};

/**
 * O-17 and WP-14's C-2: Trustless Work simulated the resolve with the escrow's
 * storage as it is now, so nothing is prepared while, inside the signing
 * window, the contract would extend its ["Escrow"] entry (a rent the
 * simulation did not price) or the escrow's instance, its entry or Trustless
 * Work's escrow code would be archived. An entry archived already is fine: the
 * simulation prices its restore.
 */
function storageProblem(ttl: EscrowTtl, code: { latestLedger: number; liveUntil: number }): string | null {
  if (ttl.escrowLiveUntil === null) {
    return "Soroban RPC gave no storage TTL for the escrow, so the rent rule cannot be checked; prepare again later.";
  }
  const rent = ttl.escrowLiveUntil - ttl.latestLedger - EXTEND_BELOW_LEDGERS;
  if (rent >= 0 && rent < WINDOW_LEDGERS) return `The escrow's storage rent falls due in about ${inAbout(rent)}; prepare after that.`;
  const live = Math.min(ttl.instanceLiveUntil, ttl.escrowLiveUntil) - ttl.latestLedger;
  if (live >= 0 && live < WINDOW_LEDGERS) {
    return `The escrow's storage is archived in about ${inAbout(live)}, inside the signing window; prepare after that.`;
  }
  const codeLive = code.liveUntil - code.latestLedger;
  if (codeLive >= 0 && codeLive < WINDOW_LEDGERS) {
    return `Trustless Work's escrow code is archived in about ${inAbout(codeLive)}, inside the signing window; prepare after that.`;
  }
  return null;
}

/** Asks Trustless Work for the resolve; its refusals become sentences, its outages the retry sentence (as escrow.ts does). */
async function askTw(input: TwInput["resolve"], tradeId: string): Promise<TwOutput["resolve"]> {
  try {
    return await twCall("resolve", input, { tradeId });
  } catch (e) {
    if (!(e instanceof TwApiError)) throw e;
    if (e.status >= 400 && e.status < 500) throw new TRPCError({ code: "BAD_REQUEST", message: describeEscrowError(e), cause: e });
    // A 2xx here is an answer in a shape Pairy does not know; anything else is no answer.
    const code = e.status >= 200 && e.status < 300 ? "BAD_GATEWAY" : "SERVICE_UNAVAILABLE";
    throw new TRPCError({ code, message: e.message, cause: e });
  }
}

/** The resolve, checked as the browser checks it before Freighter opens. Returns the signing screen's line. */
function checked(tradeId: string, tx: { unsignedXdr: string; txHash: string }, expectation: CallExpectation, refusal: string): string {
  let problems: string[];
  let summary = "";
  try {
    const decoded = decodeEscrowCall(tx);
    problems = validateEscrowCall(decoded, expectation);
    summary = describeEscrowCall(decoded);
  } catch (e) {
    problems = [`It could not be read as a transaction (${e instanceof Error ? e.message : String(e)}).`];
  }
  if (problems.length) {
    console.log(JSON.stringify({ evt: "arbiter.refused", tradeId, problems }));
    throw bad(`${refusal}: ${problems.join(" ")}`);
  }
  return summary;
}

/** The signatures in a signed copy, each checked against the prepared hash and the arbiter's signers now. */
function signaturesIn(signedXdr: string, txHash: string, signers: string[]): ArbiterSignature[] {
  try {
    return extractSignatures(signedXdr, txHash, signers);
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e));
  }
}

function resolutionView(r: Resolution, threshold: number) {
  return {
    resolutionId: r.id,
    unsignedXdr: r.unsignedXdr,
    txHash: r.txHash,
    summary: describeEscrowCall(decodeEscrowCall({ unsignedXdr: r.unsignedXdr, txHash: r.txHash })),
    expiresAt: expiryOf(r),
    threshold,
    signers: r.signers,
  };
}

/** A protected trade with a dispute on its escrow; anything else is not the arbiter's to see. */
async function disputeOf(db: Database, tradeId: string): Promise<TradeRow> {
  const [trade] = await db
    .select()
    .from(trades)
    .where(and(eq(trades.id, tradeId), eq(trades.mode, "protected"), eq(trades.disputed, true)));
  if (!trade) throw new TRPCError({ code: "NOT_FOUND", message: "No dispute for the arbiter on this trade." });
  return trade;
}

const answersOf = (rows: AnswerRow[], tradeId: string): { seller: Answer; buyer: Answer } => {
  const said = (role: TradeRole) => rows.find((a) => a.tradeId === tradeId && a.role === role)?.cashHandedOver ?? null;
  return { seller: said("seller"), buyer: said("buyer") };
};

/**
 * What the arbiter sees of one dispute: no chat, and no notes (byId adds those).
 * The outcome is shown only once the rule can be applied.
 */
function disputeView(t: TradeRow, answerRows: AnswerRow[], collecting: Resolution | undefined, threshold: number, now: Date) {
  const answers = answersOf(answerRows, t.id);
  const deadline = answerDeadline({ disputeRecordedAt: t.disputeRecordedAt! });
  const promise = promiseDeadline({ disputedAt: t.disputedAt! });
  const ready = resolutionReady(answers, deadline, now);
  const applied = ready ? ruleOutcome(answers) : null;
  return {
    tradeId: t.id,
    amount: t.amount,
    seller: t.seller,
    buyer: t.buyer,
    contractId: t.escrowContractId,
    disputedAt: t.disputedAt,
    disputeRecordedAt: t.disputeRecordedAt,
    disputeOpenedBy: t.disputeOpenedBy,
    answerDeadline: deadline,
    promiseDeadline: promise,
    overdue: now.getTime() >= promise.getTime(),
    answers,
    ready,
    outcome: applied?.outcome ?? null,
    rule: applied?.rule ?? null,
    resolution:
      collecting?.tradeId === t.id ? { id: collecting.id, signers: collecting.signers, threshold, expiresAt: expiryOf(collecting) } : null,
  };
}

export const arbiterRouter = createTRPCRouter({
  /** Lets the page tell a non-signer "This page is only for the arbiter account's signers." (R2). */
  me: protectedProcedure.query(async ({ ctx }) => {
    let state: ArbiterAccountState;
    try {
      state = await arbiterAccountState();
    } catch (e) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Couldn't confirm the signer list. Try again.", cause: e });
    }
    return {
      isSigner: state.signers.some((s) => s.key === ctx.session.publicKey),
      threshold: thresholdOf(state),
      signers: state.signers.map((s) => s.key),
    };
  }),

  /** The open disputes, the oldest promise first (PLAN I11: never the chat). */
  list: arbiterProcedure.query(async ({ ctx }) => {
    const open = await ctx.db
      .select()
      .from(trades)
      .where(and(eq(trades.mode, "protected"), eq(trades.state, "funded"), eq(trades.disputed, true)))
      .orderBy(asc(trades.disputedAt));
    if (!open.length) return [];
    const [answers, [collecting], state] = await Promise.all([
      ctx.db
        .select({ tradeId: disputeAnswers.tradeId, role: disputeAnswers.role, cashHandedOver: disputeAnswers.cashHandedOver })
        .from(disputeAnswers)
        .where(inArray(disputeAnswers.tradeId, open.map((t) => t.id))),
      ctx.db.select().from(arbiterResolutions).where(eq(arbiterResolutions.status, "collecting")),
      arbiterAccountState(),
    ]);
    const now = new Date();
    return open.map((t) => disputeView(t, answers, collecting, thresholdOf(state), now));
  }),

  /** One dispute in full: the escrow read fresh, every step on chain, both notes and the rule's sentence. Still no chat. */
  byId: arbiterProcedure.input(tradeIdInput).query(async ({ ctx, input }) => {
    const trade = await disputeOf(ctx.db, input.tradeId);
    const contractId = trade.escrowContractId!;
    const [answers, [collecting], state, escrow] = await Promise.all([
      ctx.db.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, trade.id)),
      ctx.db.select().from(arbiterResolutions).where(eq(arbiterResolutions.status, "collecting")),
      arbiterAccountState(),
      // From Soroban RPC, as the traders' browsers read it; null when it can't be read just now.
      readEscrow(contractId).catch(() => null),
    ]);
    const view = disputeView(trade, answers, collecting, thresholdOf(state), new Date());
    const note = (role: TradeRole) => answers.find((a) => a.role === role)?.note ?? null;
    const steps = (
      [
        ["create", trade.createTx],
        ["fund", trade.fundTx],
        ["dispute", trade.disputeTx],
        ["resolve", trade.resolveTx],
      ] as const
    ).flatMap(([step, txHash]) => (txHash ? [{ step, txHash, url: explorerTxUrl(txHash) }] : []));
    return {
      ...view,
      state: trade.state,
      viewerUrl: twViewerUrl(contractId),
      escrow: escrow && { terms: escrow.terms, status: escrow.status },
      steps,
      notes: { seller: note("seller"), buyer: note("buyer") },
      ruleSentence: view.rule ? RULE_SENTENCE[view.rule] : null,
      feeAddress: TW_FEE_ADDRESS,
    };
  }),

  /**
   * The one resolution the rule gives, ready to sign. The trade's open
   * resolution comes back while it can still land and still needs signatures;
   * a stale one is expired, and a fully signed one that never reached the
   * chain is failed, before a new one is prepared (FIXES F-03).
   */
  prepareResolution: arbiterProcedure.input(tradeIdInput).mutation(async ({ ctx, input }) => {
    const trade = await disputeOf(ctx.db, input.tradeId);
    if (trade.state !== "funded") throw bad("This dispute is already settled.");
    const contractId = trade.escrowContractId!;
    const answerRows = await ctx.db.select().from(disputeAnswers).where(eq(disputeAnswers.tradeId, trade.id));
    const answers = answersOf(answerRows, trade.id);
    const deadline = answerDeadline({ disputeRecordedAt: trade.disputeRecordedAt! });
    if (!resolutionReady(answers, deadline, new Date())) throw bad(`Waiting for the traders' answers until ${deadline.toISOString()}.`);
    const { outcome, rule } = ruleOutcome(answers);
    const recipient = outcome === "buyer" ? trade.buyer : trade.seller;

    const account = await arbiterNow();
    const [open] = await ctx.db.select().from(arbiterResolutions).where(eq(arbiterResolutions.status, "collecting"));
    if (open) {
      const stale = staleness(open, account.sequence);
      if (stale) await close(ctx.db, open.id, "expired");
      else if (open.tradeId !== trade.id) {
        throw bad(`Another resolution is being signed (trade ${open.tradeId.slice(0, 8)}). Finish or let it expire first.`);
      } else if (weightOf(open.signers, account) < thresholdOf(account)) return resolutionView(open, thresholdOf(account));
      else {
        const landed = await network(
          findEscrowTx(ARBITER_ACCOUNT, contractId, "resolve_dispute", open.createdAt),
          "Couldn't check Horizon for this resolution; try again in a minute.",
        );
        if (landed) throw bad("This resolution is on Stellar testnet already; refresh the trade to record it.");
        await close(ctx.db, open.id, "failed");
      }
    }

    const problems = arbiterAccountProblems(account);
    if (problems.length) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: `The arbiter account fails its check: ${problems.join("; ")}. Fix it before resolving.` });
    }
    if (TW_ESCROW_WASM_HASH === null) {
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Protected trades are paused until Pairy pins Trustless Work's escrow code again." });
    }
    const [escrow, code] = await network(
      Promise.all([readEscrow(contractId), readCodeTtl(TW_ESCROW_WASM_HASH)]),
      "Couldn't read the escrow from Stellar testnet; try again in a minute.",
    );
    if (escrow.status.resolved || escrow.status.released) throw bad("This escrow is already settled on chain; refresh the trade.");
    if (!escrow.status.disputed) throw bad("The escrow on chain is not in dispute; refresh the trade.");
    const storage = storageProblem(escrow.ttl, code);
    if (storage) throw bad(storage);

    // The contract pays out exactly its USDC balance, never the stored amount (FIXES X-07).
    const amountStroops = escrow.status.balanceStroops;
    const expectation = { kind: "resolve", contractId, resolver: ARBITER_ACCOUNT, recipient, amountStroops } as const;
    const tw = await askTw(
      { contractId, disputeResolver: ARBITER_ACCOUNT, distributions: [{ address: recipient, amount: twAmount(amountStroops) }] },
      trade.id,
    );
    checked(trade.id, tw, { ...expectation, timePolicy: "server-original" }, TW_REFUSED);
    // WP-15 judge N5: the sequence Trustless Work built on, against Horizon after it answered.
    const after = await arbiterNow();
    if (sequenceOf(tw.unsignedXdr) !== BigInt(after.sequence) + 1n) {
      throw bad("The arbiter account moved on while Trustless Work prepared this resolution; prepare again.");
    }

    // O-17: only maxTime changes, in the XDR itself; then the server asserts nothing else did,
    // and checks the result as the browser will, its window between 10 minutes and 24 hours.
    const maxTime = await network(networkDeadline(RESOLVE_WINDOW_SECONDS), "Couldn't read Horizon's clock; try again in a minute.");
    const rebuilt = rebuildMaxTime(tw.unsignedXdr, maxTime);
    if (!onlyMaxTimeChanged(tw.unsignedXdr, rebuilt.unsignedXdr)) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The re-timed resolution differs from Trustless Work's in more than its expiry. Nothing was stored." });
    }
    checked(trade.id, rebuilt, { ...expectation, timePolicy: "browser-rebuilt" }, REBUILT_REFUSED);

    // Only the re-timed transaction is stored (WP-10 N1): it is what the signers sign.
    const [stored] = await ctx.db
      .insert(arbiterResolutions)
      .values({
        tradeId: trade.id,
        outcome,
        rule,
        recipient,
        amount: fromStroops(amountStroops),
        unsignedXdr: rebuilt.unsignedXdr,
        txHash: rebuilt.txHash,
        signedXdr: rebuilt.unsignedXdr,
        preparedBy: ctx.session.publicKey,
        expiresAt: new Date(maxTime * 1000),
      })
      // arbiter_resolutions_one_open: another prepare stored its resolution first.
      .onConflictDoNothing()
      .returning();
    if (!stored) throw new TRPCError({ code: "CONFLICT", message: "Another resolution was prepared at the same moment. Reload the page." });
    return resolutionView(stored, thresholdOf(after));
  }),

  /**
   * The caller's own signature, from the copy their Freighter signed, added to
   * the prepared resolution. Once the threshold is met, the returned envelope
   * is the one to send.
   */
  addSignature: arbiterProcedure
    .input(z.object({ resolutionId: z.string().uuid(), signedXdr: z.string().min(1).max(SIGNED_XDR_MAX) }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.session.publicKey;
      const [found] = await ctx.db.select().from(arbiterResolutions).where(eq(arbiterResolutions.id, input.resolutionId));
      if (!found) throw new TRPCError({ code: "NOT_FOUND", message: "No such resolution." });
      if (found.status !== "collecting") throw bad(CLOSED[found.status]);
      const account = await arbiterNow();
      const stale = staleness(found, account.sequence);
      if (stale) {
        await close(ctx.db, found.id, "expired");
        throw bad(stale);
      }
      const signers = account.signers.map((s) => s.key);
      const mine = signaturesIn(input.signedXdr, found.txHash, signers).find((s) => s.signer === me);
      if (!mine) throw bad("This copy carries no signature by your key. Sign it with the signer key you signed in with.");
      const threshold = thresholdOf(account);

      return ctx.db.transaction(async (tx) => {
        // The row is locked while its signatures are merged, so two signers at once both count.
        const [r] = await tx.select().from(arbiterResolutions).where(eq(arbiterResolutions.id, found.id)).for("update");
        if (r.status !== "collecting") throw bad(CLOSED[r.status]);
        if (r.signers.includes(me)) throw bad("You already signed this resolution.");
        // One signature past the threshold and the network refuses the transaction (tx_bad_auth_extra).
        if (weightOf(r.signers, account) >= threshold) throw bad("This resolution already has the signatures it needs.");
        // Merged: only what extractSignatures returned (WP-10 N1), the stored ones checked again and the caller's.
        const sigs = [...signaturesIn(r.signedXdr, r.txHash, signers), mine];
        const signedXdr = mergeSignatures(r.unsignedXdr, sigs);
        const signed = sigs.map((s) => s.signer);
        await tx.update(arbiterResolutions).set({ signedXdr, signers: signed }).where(eq(arbiterResolutions.id, r.id));
        return { signedXdr, signerCount: signed.length, threshold, signers: signed };
      });
    }),

  /**
   * The browser sent the resolve; Horizon shows it. It must be a resolution
   * prepared here for this trade and pay out exactly what it prepared. Then the
   * trade ends (its chat and notes go with it) and the resolution is marked sent.
   */
  recordResolution: arbiterProcedure
    .input(tradeIdInput.extend({ txHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "Not a Stellar transaction hash").transform((h) => h.toLowerCase()) }))
    .mutation(async ({ ctx, input }) => {
      const trade = await disputeOf(ctx.db, input.tradeId);
      const [prepared] = await ctx.db
        .select()
        .from(arbiterResolutions)
        .where(and(eq(arbiterResolutions.tradeId, trade.id), eq(arbiterResolutions.txHash, input.txHash)));
      const markSent = () =>
        ctx.db
          .update(arbiterResolutions)
          .set({ status: "submitted", submittedTx: input.txHash })
          .where(and(eq(arbiterResolutions.tradeId, trade.id), eq(arbiterResolutions.txHash, input.txHash)));
      // Recorded already, by this procedure or by the trade's sync.
      if (trade.resolveTx === input.txHash) {
        await markSent();
        return trade;
      }
      if (!prepared) throw bad("This transaction is not a resolution prepared for this trade.");
      const landed = await chain(
        verifyEscrowTx(input.txHash, {
          kind: "resolve",
          contractId: trade.escrowContractId!,
          resolver: ARBITER_ACCOUNT,
          parties: { seller: trade.seller, buyer: trade.buyer },
        }),
      );
      const paid = landed.payout!;
      const amount = toStroops(prepared.amount);
      if (paid.to !== prepared.recipient || paid.amountStroops !== amount) {
        throw bad(
          `The resolve on chain paid ${fromStroops(paid.amountStroops)} USDC to ${paid.to}, not the prepared ${fromStroops(amount)} USDC to ${prepared.recipient}.`,
        );
      }
      // Terminal: transitionTrade deletes the chat and the dispute notes with it (SOW D3).
      const updated = await transitionTrade(ctx.db, trade.id, {
        type: "resolve",
        by: "arbiter",
        outcome: prepared.outcome,
        txHash: input.txHash,
        resolvedAt: landed.createdAt,
      });
      await markSent();
      return updated;
    }),
});
