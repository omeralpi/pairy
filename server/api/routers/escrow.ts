// The escrow router (D2 §5.2): a protected trade's Trustless Work escrow,
// created, funded and released, or disputed and answered by both traders.
// The arbiter's resolution is the arbiter router's (arbiter.ts).
//
// Pairy's server never signs and never submits (PLAN I1, I3). For each step it
// asks Trustless Work for the unsigned transaction, built only from the trade
// row and the committed constants, checks it with validateEscrowCall before
// returning it (DECISIONS 7), and the trader's own wallet signs it and sends
// it to Horizon from the browser. The browser then reports the hash, and the
// step is recorded only once the transaction has been read back from Horizon
// and the escrow from Soroban RPC (PLAN I9). Trustless Work prepares calls a
// trade is not ready for (WP-08), so every step checks the trade's own state
// first.

import { StrKey } from "@stellar/stellar-sdk";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";

import { disputeAnswers, tradeEvents, trades } from "@/lib/db/schema";
import { ACCEPTANCE_ITEMS, ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import {
  ARBITER_ACCOUNT,
  DISPUTE_REASON,
  ESCROW_XLM_NEED,
  NOTE_MAX,
  PLATFORM_ACCOUNT,
  PROTECTED_WALLET_KINDS,
  TW_ESCROW_WASM_HASH,
  TW_FACTORY_CONTRACT_ID,
  TW_FEE_ADDRESS,
  TW_VIEWER_BASE,
  USDC_SAC,
} from "@/lib/escrow/config";
import { describeEscrowError } from "@/lib/escrow/errors";
import { netAfterFee, twFee } from "@/lib/escrow/fee";
import { EscrowNotFoundError, readEscrow, readWasmHash } from "@/lib/escrow/read";
import { answerDeadline } from "@/lib/escrow/rule";
import { checkEscrowTerms, expectedTerms, type EscrowTerms } from "@/lib/escrow/terms";
import { findEscrowTx, verifyEscrowTx, type EscrowTransfer } from "@/lib/escrow/verify";
import { decodeEscrowCall, describeEscrowCall, validateEscrowCall, type CallExpectation } from "@/lib/escrow/xdr";
import { hasTrustline, loadAccount } from "@/lib/stellar/horizon";
import { VerifyError } from "@/lib/stellar/verify";
import { fromStroops, toStroops } from "@/lib/trade/amount";
import { tradeForParticipant, transitionTrade, type Database, type TradeRow } from "@/lib/trade/persist";
import { minimumBalance, receivable, spendable, type PreflightCheck } from "@/lib/trade/preflight";
import { chain } from "@/lib/trade/sync";
import type { TradeRole } from "@/lib/trade/state-machine";
import { arbiterAccountProblems, arbiterAccountState } from "@/server/api/arbiter-auth";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "@/server/api/trpc";
import { TwApiError, twAmount, twCall, twConfigured, type TwEndpoint, type TwInput, type TwOutput } from "@/server/tw/client";

/** The kill switch for new protected trades (DECISIONS 6): only "on" opens them. Trades already open go on either way. */
export function protectedModeOn(): boolean {
  return process.env.PROTECTED_MODE?.trim() === "on";
}

/** One Trustless Work prepare per trade every 5 seconds (MC-27). */
const PREPARE_INTERVAL_MS = 5_000;
/** A prepared deploy is valid 5 minutes; after 15 an earlier creation key that sent one may be replaced. */
const REPLACE_CREATION_AFTER_MS = 15 * 60_000;
/** The factory call that deploys an escrow (lib/escrow/xdr.ts checks the same name). */
const DEPLOY_FN = "tw_new_single_release_escrow";

const tradeIdInput = z.object({ tradeId: z.string().uuid() });
const txInput = tradeIdInput.extend({
  txHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "Not a Stellar transaction hash").transform((h) => h.toLowerCase()),
});

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

/** The caller's protected trade; NOT_FOUND for anyone who is not one of its traders. */
async function protectedTrade(db: Database, tradeId: string, me: string): Promise<{ trade: TradeRow; role: TradeRole }> {
  const found = await tradeForParticipant(db, tradeId, me);
  if (found.trade.mode !== "protected") throw bad("This is not a protected trade.");
  return found;
}

function sellerOnly(role: TradeRole, message: string) {
  if (role !== "seller") throw new TRPCError({ code: "FORBIDDEN", message });
}

/** The escrow the trade recorded from the chain, or null before its creation is recorded. */
function recordedEscrow(t: TradeRow): { contractId: string; admin: string } | null {
  return t.createTx !== null && t.escrowContractId !== null && t.escrowAdmin !== null ? { contractId: t.escrowContractId, admin: t.escrowAdmin } : null;
}

/**
 * Trustless Work's factory and escrow code, as pinned. After a testnet reset
 * they are null until re-pinned (WP-46), and xdr.ts then checks neither, so no
 * escrow is created or recorded meanwhile.
 */
function pinned(): { factory: string; wasm: string } {
  if (TW_FACTORY_CONTRACT_ID === null || TW_ESCROW_WASM_HASH === null) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Protected trades are paused until Pairy pins Trustless Work's escrow code again." });
  }
  return { factory: TW_FACTORY_CONTRACT_ID, wasm: TW_ESCROW_WASM_HASH };
}

const termsFor = (t: TradeRow, admin: string): EscrowTerms =>
  expectedTerms({ buyer: t.buyer, seller: t.seller, amount: t.amount, escrowAdmin: admin });

/**
 * The deploy request, from the same terms the answer is checked against, so
 * the two cannot drift. engagementId is the trade's id: Trustless Work does
 * not keep engagement ids unique (WP-03), the trade's primary key is, and
 * Pairy never looks an escrow up by it.
 */
function deployBody(tradeId: string, terms: EscrowTerms): TwInput["deploy"] {
  return {
    signer: terms.admin,
    engagementId: tradeId,
    title: `Pairy trade ${tradeId.slice(0, 8)}`,
    description: "Pairy protected trade, Stellar testnet",
    roles: {
      approvers: terms.approvers,
      serviceProviders: terms.serviceProviders,
      releaseSigners: terms.releaseSigners,
      receiver: terms.receiver,
      platform: terms.platform,
      disputeResolvers: terms.disputeResolvers,
      admin: terms.admin,
    },
    amount: twAmount(terms.amountStroops),
    platformFee: terms.platformFeePercent,
    trustline: { contractId: terms.tokenContract },
    milestones: terms.milestones,
  };
}

/** Asks Trustless Work; its refusals become sentences (describeEscrowError), its outages the retry sentence. */
async function askTw<E extends TwEndpoint>(ep: E, input: TwInput[E], tradeId: string): Promise<TwOutput[E]> {
  try {
    return await twCall(ep, input, { tradeId });
  } catch (e) {
    if (!(e instanceof TwApiError)) throw e;
    if (e.status >= 400 && e.status < 500) throw new TRPCError({ code: "BAD_REQUEST", message: describeEscrowError(e), cause: e });
    // A 2xx here is an answer in a shape Pairy does not know; anything else is no answer.
    const code = e.status >= 200 && e.status < 300 ? "BAD_GATEWAY" : "SERVICE_UNAVAILABLE";
    throw new TRPCError({ code, message: e.message, cause: e });
  }
}

/**
 * Trustless Work's transaction, checked as the browser will check it again
 * before the wallet opens. Anything wrong and nobody is asked to sign it.
 */
function checked(tradeId: string, prepared: { unsignedXdr: string; txHash: string }, expectation: CallExpectation) {
  let problems: string[];
  let summary = "";
  try {
    const decoded = decodeEscrowCall(prepared);
    problems = validateEscrowCall(decoded, expectation);
    summary = describeEscrowCall(decoded);
  } catch (e) {
    problems = [`It could not be read as a transaction (${e instanceof Error ? e.message : String(e)}).`];
  }
  if (problems.length) {
    console.log(JSON.stringify({ evt: "escrow.refused", tradeId, kind: expectation.kind, problems }));
    throw bad(`Trustless Work returned a transaction Pairy won't ask you to sign: ${problems.join(" ")}`);
  }
  // txHash lets the browser's own check tie the transaction to testnet; summary is the signing dialog's line.
  return { unsignedXdr: prepared.unsignedXdr, txHash: prepared.txHash, summary };
}

/** Claims the trade's prepare slot in one statement, so two prepares at once cannot both reach Trustless Work. */
async function claimPrepare(db: Database, tradeId: string) {
  const now = new Date();
  const [claimed] = await db
    .update(trades)
    .set({ escrowPreparedAt: now })
    .where(
      and(
        eq(trades.id, tradeId),
        or(isNull(trades.escrowPreparedAt), lt(trades.escrowPreparedAt, new Date(now.getTime() - PREPARE_INTERVAL_MS))),
      ),
    )
    // returning() without a field map: the Db | TestDb union loses that overload.
    .returning();
  if (!claimed) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Wait a few seconds before asking again." });
}

/** chain() for escrow steps: an escrow Soroban RPC does not show yet is a sentence, not an outage. */
function onChain<T>(p: Promise<T>): Promise<T> {
  return chain(
    p.catch((e: unknown) => {
      if (e instanceof EscrowNotFoundError) throw new VerifyError("Stellar testnet doesn't show the new escrow yet. Try again in a few seconds.");
      throw e;
    }),
  );
}

/**
 * Whether an earlier prepared creation may be replaced (D2 §5.2, FIXES
 * F-02): its escrow must not exist, and its creation key must not have sent a
 * deploy in the last 15 minutes. Only "no contract there" counts as no
 * contract (C-5); when Soroban RPC or Horizon can't be read, it is refused.
 */
async function mayReplaceCreation(earlier: { contractId: string; admin: string; preparedAt: Date | null; since: Date }, factory: string) {
  const unchecked = (e: unknown) =>
    new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Couldn't check Stellar testnet for this trade's earlier escrow creation. Try again in a minute.", cause: e });
  let exists = true;
  try {
    await readEscrow(earlier.contractId);
  } catch (e) {
    if (!(e instanceof EscrowNotFoundError)) throw unchecked(e);
    exists = false;
  }
  if (exists) throw bad("This trade's escrow already exists on Stellar testnet. This page records it.");
  if (earlier.preparedAt !== null && Date.now() - earlier.preparedAt.getTime() >= REPLACE_CREATION_AFTER_MS) return;
  const sent = await findEscrowTx(earlier.admin, factory, DEPLOY_FN, earlier.since).catch((e: unknown) => {
    throw unchecked(e);
  });
  if (sent) throw bad("An escrow creation was already sent. This page is checking the network.");
}

type EscrowCheckId =
  | "bothAccepted"
  | "arbiterAccount"
  | "platformAccount"
  | "sellerAccount"
  | "sellerUsdc"
  | "sellerXlm"
  | "buyerAccount"
  | "buyerTrustline"
  | "escrowTerms"
  | "escrowEmpty";
export type EscrowCheck = Omit<PreflightCheck, "id"> & { id: EscrowCheckId };

const xlm = (stroops: bigint) => `${fromStroops(stroops < 0n ? 0n : stroops)} XLM`;

/**
 * What must hold before the escrow is created or funded, read from Horizon and
 * Soroban RPC so the panel can block early (the lock's checkLock, for the
 * escrow). Horizon errors on the traders' accounts propagate, as in
 * trade.lockPreflight; the arbiter account and the escrow fail their check instead.
 */
async function escrowPreflight(trade: TradeRow): Promise<{ ok: boolean; blockedReason: string | null; checks: EscrowCheck[] }> {
  const amount = toStroops(trade.amount);
  const escrowId = recordedEscrow(trade);
  const [seller, buyer, platform, arbiter, escrow] = await Promise.all([
    loadAccount(trade.seller),
    loadAccount(trade.buyer),
    loadAccount(PLATFORM_ACCOUNT),
    arbiterAccountState().catch(() => null),
    escrowId ? readEscrow(escrowId.contractId).catch(() => null) : undefined,
  ]);
  const checks: EscrowCheck[] = [];
  const add = (id: EscrowCheckId, ok: boolean, label: string, detail: string) => checks.push({ id, ok, label, detail: ok ? null : detail });

  add(
    "bothAccepted",
    trade.sellerAcceptedAt !== null && trade.buyerAcceptedAt !== null,
    "Both of you accepted the protected-trade terms",
    "Both of you must accept the protected-trade terms first.",
  );

  const arbiterProblems = arbiter ? arbiterAccountProblems(arbiter) : null;
  add(
    "arbiterAccount",
    arbiterProblems?.length === 0,
    "The arbiter account needs two of its signers to act",
    arbiterProblems === null
      ? "Couldn't check the arbiter account; try again."
      : `The arbiter account fails its check: ${arbiterProblems.join("; ")}. Protected trades wait until it is fixed.`,
  );

  const platformOwnWeight = platform?.signers.find((s) => s.key === PLATFORM_ACCOUNT)?.weight ?? 0;
  add(
    "platformAccount",
    platform !== null && platformOwnWeight === 0 && hasTrustline(platform, "USDC"),
    "The platform account cannot sign and holds a USDC trustline",
    "The platform account is not as Pairy set it up (its own key switched off, a USDC trustline). Protected trades wait until it is fixed.",
  );

  add("sellerAccount", seller !== null, "Your account exists on testnet", "Your account does not exist on testnet yet. Fund it with Friendbot first.");
  if (seller) {
    // Until it is funded, the escrow's USDC is still the seller's to hold.
    if (trade.fundTx === null) {
      const held = spendable(seller, "USDC");
      add("sellerUsdc", held >= amount, `You hold ${fromStroops(amount)} USDC`, `You need ${fromStroops(amount)} USDC but hold ${fromStroops(held < 0n ? 0n : held)} USDC.`);
    }
    const min = minimumBalance(seller);
    const free = spendable(seller, "XLM") - min;
    add(
      "sellerXlm",
      free >= ESCROW_XLM_NEED,
      `You can cover the escrow's network fees in XLM`,
      `You need ${xlm(ESCROW_XLM_NEED)} above your ${xlm(min)} minimum balance for the escrow's network fees, but only ${xlm(free)} is available.`,
    );
  }

  add(
    "buyerAccount",
    buyer !== null,
    "The buyer's account exists on testnet",
    "The buyer's account does not exist on testnet yet. They need to create and fund it first.",
  );
  if (buyer) {
    const receive = receivable(buyer, "USDC", amount);
    add(
      "buyerTrustline",
      receive === "ok",
      "The buyer can receive USDC",
      {
        ok: "",
        // Trustless Work refuses the deploy with 422 when the receiver has no trustline (WP-11).
        missing: "The buyer needs to add a USDC trustline first. Without it Trustless Work cannot create the escrow.",
        unauthorized: "The USDC issuer has not authorized the buyer's trustline, so the buyer could not be paid.",
        full: `The buyer's USDC trustline limit leaves no room for ${fromStroops(amount)} USDC. They need to raise the limit first.`,
      }[receive],
    );
  }

  if (escrowId) {
    const problems = escrow ? checkEscrowTerms(escrow.terms, termsFor(trade, escrowId.admin)) : null;
    add(
      "escrowTerms",
      problems?.length === 0,
      "The escrow on Stellar testnet has this trade's terms",
      problems === null ? "Could not read the escrow from Stellar testnet; try again." : `Don't fund this escrow: ${problems.map((p) => p.message).join(" ")}`,
    );
    // A second fund would leave USDC in the escrow that the release does not pay out.
    if (trade.state === "escrow_created" && escrow) {
      const s = escrow.status;
      add(
        "escrowEmpty",
        s.balanceStroops === 0n && !s.released && !s.disputed,
        "The escrow holds nothing yet",
        "This escrow already holds USDC. Don't fund it again; this page records the fund.",
      );
    }
  }

  const failed = checks.find((c) => !c.ok);
  return { ok: !failed, blockedReason: failed?.detail ?? null, checks };
}

/**
 * F-10: a release pays the buyer the net and Trustless Work 0.3% at its
 * pinned address. The release is on chain either way, so a difference is
 * logged for EVIDENCE, not refused.
 */
function logFeeMismatch(trade: TradeRow, contractId: string, transfers: EscrowTransfer[]) {
  if (TW_FEE_ADDRESS === null) return;
  const amount = toStroops(trade.amount);
  const expected: EscrowTransfer[] = [
    { from: contractId, to: TW_FEE_ADDRESS, amountStroops: twFee(amount) },
    { from: contractId, to: trade.buyer, amountStroops: netAfterFee(amount) },
  ];
  const key = (t: EscrowTransfer) => `${t.from}>${t.to}:${t.amountStroops}`;
  if (transfers.map(key).sort().join() === expected.map(key).sort().join()) return;
  console.log(
    JSON.stringify({ evt: "escrow.fee_mismatch", tradeId: trade.id, transfers: transfers.map((t) => ({ ...t, amountStroops: String(t.amountStroops) })) }),
  );
}

export const escrowRouter = createTRPCRouter({
  /** What the protected-trade toggle and acceptance screen need. `enabled` governs only new trades. */
  config: publicProcedure.query(() => ({
    enabled: protectedModeOn() && twConfigured(),
    arbiterAccount: ARBITER_ACCOUNT,
    platformAccount: PLATFORM_ACCOUNT,
    usdcContract: USDC_SAC,
    viewerBase: TW_VIEWER_BASE,
    acceptanceVersion: ACCEPTANCE_VERSION,
    acceptanceItems: ACCEPTANCE_ITEMS,
    protectedWalletKinds: PROTECTED_WALLET_KINDS,
  })),

  preflight: protectedProcedure.input(tradeIdInput).query(async ({ ctx, input }) => {
    const { trade } = await protectedTrade(ctx.db, input.tradeId, ctx.session.publicKey);
    return escrowPreflight(trade);
  }),

  /** `admin` is the public address of the creation key the seller's browser made; its secret never leaves the browser (PLAN I5). */
  prepareCreate: protectedProcedure
    .input(tradeIdInput.extend({ admin: z.string().refine((s) => StrKey.isValidEd25519PublicKey(s), "Not a Stellar account address") }))
    .mutation(async ({ ctx, input }) => {
      const { trade, role } = await protectedTrade(ctx.db, input.tradeId, ctx.session.publicKey);
      sellerOnly(role, "Only the seller creates the escrow.");
      if (trade.state !== "agreed") throw bad("Only an agreed trade gets an escrow.");
      const { factory } = pinned();
      // Trustless Work requires an admin distinct from every other role (WP-03 judge N5).
      if ([trade.seller, trade.buyer, ARBITER_ACCOUNT, PLATFORM_ACCOUNT].includes(input.admin)) {
        throw bad("The creation key must be a new account of its own, not one of the trade's accounts.");
      }
      if (trade.escrowContractId !== null && trade.escrowAdmin !== null) {
        await mayReplaceCreation(
          { contractId: trade.escrowContractId, admin: trade.escrowAdmin, preparedAt: trade.escrowPreparedAt, since: trade.createdAt },
          factory,
        );
      }
      const [admin, preflight] = await Promise.all([loadAccount(input.admin), escrowPreflight(trade)]);
      if (!admin) throw bad("The creation account isn't on Stellar testnet yet. Fund it with Friendbot first.");
      if (!preflight.ok) throw bad(preflight.blockedReason ?? "The escrow can't be created yet.");

      await claimPrepare(ctx.db, trade.id);
      const terms = termsFor(trade, input.admin);
      const out = await askTw("deploy", deployBody(trade.id, terms), trade.id);
      const call = checked(trade.id, out, { kind: "deploy", admin: input.admin, contractId: out.contractId, terms });
      // F-02: the creation key's address and the escrow's address, stored before anything is signed.
      // One statement, and only if nothing changed since the checks above.
      const [stored] = await ctx.db
        .update(trades)
        .set({ escrowAdmin: input.admin, escrowContractId: out.contractId })
        .where(
          and(
            eq(trades.id, trade.id),
            eq(trades.state, "agreed"),
            trade.escrowContractId === null ? isNull(trades.escrowContractId) : eq(trades.escrowContractId, trade.escrowContractId),
          ),
        )
        .returning();
      if (!stored) throw new TRPCError({ code: "CONFLICT", message: "This trade changed while the escrow was being prepared. Reload the page." });
      return { ...call, contractId: out.contractId };
    }),

  /** Either trader may report it; the chain says what happened. */
  recordCreate: protectedProcedure.input(txInput).mutation(async ({ ctx, input }) => {
    const { trade } = await protectedTrade(ctx.db, input.tradeId, ctx.session.publicKey);
    if (trade.createTx === input.txHash) return trade;
    if (trade.createTx !== null) throw bad("This trade's escrow is already recorded.");
    if (trade.state !== "agreed") throw bad("Only an agreed trade gets an escrow.");
    if (trade.escrowAdmin === null || trade.escrowContractId === null) throw bad("No escrow creation was prepared for this trade.");
    const { wasm } = pinned();
    const terms = termsFor(trade, trade.escrowAdmin);
    const landed = await onChain(
      verifyEscrowTx(input.txHash, { kind: "deploy", admin: trade.escrowAdmin, contractId: trade.escrowContractId, terms }),
    );
    const [escrow, wasmHash] = await onChain(Promise.all([readEscrow(landed.contractId), readWasmHash(landed.contractId)]));
    const problems = checkEscrowTerms(escrow.terms, terms).map((p) => p.message);
    if (wasmHash !== wasm) problems.push(`It runs contract code ${wasmHash}, not Trustless Work's escrow ${wasm}.`);
    if (problems.length) throw bad(`The escrow on Stellar testnet is not this trade's: ${problems.join(" ")}`);
    return transitionTrade(ctx.db, trade.id, { type: "escrowCreate", by: "seller", contractId: landed.contractId, txHash: input.txHash });
  }),

  prepareFund: protectedProcedure.input(tradeIdInput).mutation(async ({ ctx, input }) => {
    const { trade, role } = await protectedTrade(ctx.db, input.tradeId, ctx.session.publicKey);
    sellerOnly(role, "Only the seller funds the escrow.");
    if (trade.fundTx !== null) throw bad("This escrow is already funded.");
    const escrow = recordedEscrow(trade);
    if (trade.state !== "escrow_created" || !escrow) throw bad("Only a created escrow can be funded.");
    const preflight = await escrowPreflight(trade);
    if (!preflight.ok) throw bad(preflight.blockedReason ?? "The escrow can't be funded yet.");

    await claimPrepare(ctx.db, trade.id);
    const terms = termsFor(trade, escrow.admin);
    const out = await askTw("fund", { contractId: escrow.contractId, signer: trade.seller, amount: twAmount(terms.amountStroops) }, trade.id);
    return checked(trade.id, out, { kind: "fund", contractId: escrow.contractId, seller: trade.seller, amountStroops: terms.amountStroops, terms });
  }),

  recordFund: protectedProcedure.input(txInput).mutation(async ({ ctx, input }) => {
    const { trade } = await protectedTrade(ctx.db, input.tradeId, ctx.session.publicKey);
    if (trade.fundTx === input.txHash) return trade;
    if (trade.fundTx !== null) throw bad("This escrow is already funded.");
    const escrow = recordedEscrow(trade);
    // A fund that lands after a cancel is still the seller's USDC in the escrow: recorded, not refused (chain wins).
    if (!escrow || (trade.state !== "escrow_created" && trade.state !== "cancelled")) throw bad("Only a created escrow can be funded.");
    const terms = termsFor(trade, escrow.admin);
    const { createdAt } = await onChain(
      verifyEscrowTx(input.txHash, { kind: "fund", contractId: escrow.contractId, seller: trade.seller, amountStroops: terms.amountStroops, terms }),
    );
    return transitionTrade(ctx.db, trade.id, {
      type: "fund",
      by: "seller",
      txHash: input.txHash,
      fundedAt: createdAt,
      reconcile: trade.state === "cancelled",
    });
  }),

  prepareRelease: protectedProcedure.input(tradeIdInput).mutation(async ({ ctx, input }) => {
    const { trade, role } = await protectedTrade(ctx.db, input.tradeId, ctx.session.publicKey);
    sellerOnly(role, "Only the seller releases the escrow.");
    const escrow = recordedEscrow(trade);
    if (trade.state !== "funded" || !escrow) throw bad("Only a funded escrow can be released.");
    if (trade.disputed) throw bad("This escrow is in dispute; only the arbiter can settle it now.");
    // O-24: then the chain. A dispute or a settlement Pairy has not recorded yet makes the release
    // fail on chain, and the seller would pay its fee for nothing; sync records what the chain shows.
    let onChain;
    try {
      onChain = (await readEscrow(escrow.contractId)).status;
    } catch (e) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Couldn't read the escrow from Stellar testnet; try again in a minute.", cause: e });
    }
    if (onChain.disputed) throw bad("This trade has a dispute on chain; refresh the trade. Only the arbiter can settle it now.");
    if (onChain.released || onChain.resolved) throw bad("This escrow is already settled on chain; refresh the trade.");

    await claimPrepare(ctx.db, trade.id);
    // The escrow's one milestone (index 0); no milestone-status step (FIXES F-20).
    const out = await askTw("approveAndRelease", { contractId: escrow.contractId, signer: trade.seller, milestoneIndexes: [0] }, trade.id);
    return checked(trade.id, out, { kind: "release", contractId: escrow.contractId, seller: trade.seller });
  }),

  recordRelease: protectedProcedure.input(txInput).mutation(async ({ ctx, input }) => {
    const { trade } = await protectedTrade(ctx.db, input.tradeId, ctx.session.publicKey);
    if (trade.releaseTx === input.txHash) return trade;
    const escrow = recordedEscrow(trade);
    if (trade.state !== "funded" || !escrow) throw bad("Only a funded escrow can be released.");
    const { transfers } = await onChain(verifyEscrowTx(input.txHash, { kind: "release", contractId: escrow.contractId, seller: trade.seller }));
    logFeeMismatch(trade, escrow.contractId, transfers);
    // Terminal: transitionTrade deletes the chat with it (SOW D3).
    return transitionTrade(ctx.db, trade.id, { type: "release", by: "seller", txHash: input.txHash });
  }),

  /** Either trader may dispute a funded escrow; from then on only the arbiter can move its USDC, by the published rule. */
  prepareDispute: protectedProcedure.input(tradeIdInput).mutation(async ({ ctx, input }) => {
    const { trade } = await protectedTrade(ctx.db, input.tradeId, ctx.session.publicKey);
    const escrow = recordedEscrow(trade);
    if (trade.state !== "funded" || !escrow) throw bad("Only a funded escrow can be disputed.");
    if (trade.disputed) throw bad("This escrow is already in dispute; only the arbiter can settle it now.");
    // Then the chain, as for the release (O-24): a dispute or a settlement Pairy has not recorded
    // yet would make this one fail on chain, at the trader's cost; sync records what the chain shows.
    let onChain;
    try {
      onChain = (await readEscrow(escrow.contractId)).status;
    } catch (e) {
      throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Couldn't read the escrow from Stellar testnet; try again in a minute.", cause: e });
    }
    if (onChain.disputed) throw bad("This trade already has a dispute on chain; refresh the trade.");
    if (onChain.released || onChain.resolved) throw bad("This escrow is already settled on chain; refresh the trade.");

    await claimPrepare(ctx.db, trade.id);
    // The caller disputes for themselves, with the fixed reason: public on chain, it names nobody.
    const signer = ctx.session.publicKey;
    const out = await askTw("dispute", { contractId: escrow.contractId, signer, reason: DISPUTE_REASON }, trade.id);
    return checked(trade.id, out, { kind: "dispute", contractId: escrow.contractId, signer });
  }),

  /** Either trader may report it; the transaction says who opened the dispute. */
  recordDispute: protectedProcedure.input(txInput).mutation(async ({ ctx, input }) => {
    const { trade } = await protectedTrade(ctx.db, input.tradeId, ctx.session.publicKey);
    if (trade.disputeTx === input.txHash) return trade;
    if (trade.disputeTx !== null) throw bad("This trade's dispute is already recorded.");
    const escrow = recordedEscrow(trade);
    if (trade.state !== "funded" || !escrow) throw bad("Only a funded escrow can be disputed.");
    const landed = await onChain(
      verifyEscrowTx(input.txHash, { kind: "dispute", contractId: escrow.contractId, parties: { seller: trade.seller, buyer: trade.buyer } }),
    );
    // disputed_at is the ledger time; the 24 hours to answer start now, when Pairy records it (DECISIONS 1).
    const by = landed.signer === trade.seller ? "seller" : "buyer";
    return transitionTrade(ctx.db, trade.id, { type: "escrowDispute", by, txHash: input.txHash, disputedAt: landed.createdAt });
  }),

  /** Each trader's one answer to "Was the cash handed over in full?", final once saved (DECISIONS 10). */
  answer: protectedProcedure
    .input(
      tradeIdInput.extend({
        cashHandedOver: z.boolean(),
        /** Shown to the other trader and the arbiter; deleted with the chat when the trade ends. */
        note: z
          .string()
          .trim()
          .max(NOTE_MAX)
          // Postgres text cannot hold U+0000; without this the insert fails as a 500.
          .refine((s) => !s.includes("\0"), "The note contains a character that can't be saved")
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { role } = await protectedTrade(ctx.db, input.tradeId, ctx.session.publicKey);
      return ctx.db.transaction(async (tx) => {
        // FOR SHARE, as chat.send: a terminal transition waits for this answer to commit, so its purge
        // clears this note too, and this read waits for a transition already in flight.
        const [trade] = await tx.select().from(trades).where(eq(trades.id, input.tradeId)).for("share");
        if (trade.state !== "funded" || !trade.disputed || trade.disputeRecordedAt === null) {
          throw bad("This trade has no open dispute to answer.");
        }
        const deadline = answerDeadline({ disputeRecordedAt: trade.disputeRecordedAt });
        if (Date.now() >= deadline.getTime()) throw bad(`Answers closed at ${deadline.toISOString()}.`);
        // The primary key (trade, role) keeps one answer per side; no path updates it.
        const [saved] = await tx
          .insert(disputeAnswers)
          .values({ tradeId: trade.id, role, cashHandedOver: input.cashHandedOver, note: input.note || null })
          .onConflictDoNothing()
          .returning();
        if (!saved) throw bad("You already answered.");
        await tx.insert(tradeEvents).values({ tradeId: trade.id, type: input.cashHandedOver ? "answerYes" : "answerNo", by: role });
        return trade;
      });
    }),
});
