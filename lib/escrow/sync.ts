// Brings a protected trade's record in line with its escrow on chain (D2 §4.1,
// "chain wins"): a creation, fund, release, dispute or resolution that landed
// but was never reported (a closed tab, a failed request, a dispute opened
// outside Pairy's app) is found and recorded through the normal transitions.
//
// The escrow's state is read from Soroban RPC, never from Trustless Work's
// read model (WP-03), and the transaction that made each step is found on
// Horizon and put through verifyEscrowTx before anything is recorded. Nothing
// is invented: a step the chain shows but no transaction explains is logged
// (sync.unplaced) and left for the next sync. An archived escrow is read like
// a live one; only EscrowNotFoundError means there is no contract (C-3).

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import { trades } from "@/lib/db/schema";
import { VerifyError } from "@/lib/stellar/verify";
import { toStroops } from "@/lib/trade/amount";
import { transitionTrade, type Database, type TradeRow } from "@/lib/trade/persist";

import { ARBITER_ACCOUNT, TW_ESCROW_WASM_HASH, TW_FACTORY_CONTRACT_ID } from "./config";
import { EscrowNotFoundError, readEscrow, readWasmHash } from "./read";
import { checkEscrowTerms, expectedTerms, type EscrowStatus } from "./terms";
import { findEscrowTx, verifyEscrowTx } from "./verify";

type Escrow = Awaited<ReturnType<typeof readEscrow>>;

/**
 * Funded on chain: the escrow holds the trade's amount in USDC (its SAC
 * balance, FIXES X-07), or it has already paid out by a release or a
 * resolution. A stray transfer below the amount is not a fund.
 */
function fundedOnChain(status: EscrowStatus, trade: TradeRow): boolean {
  return status.balanceStroops >= toStroops(trade.amount) || status.released || status.resolved;
}

function unplaced(trade: TradeRow, step: string, why: string): TradeRow {
  console.log(JSON.stringify({ evt: "sync.unplaced", tradeId: trade.id, step, contractId: trade.escrowContractId, why }));
  return trade;
}

/** A transaction that is not the step it seemed to be is left unplaced; an outage goes to the caller. */
async function placed<T>(trade: TradeRow, step: string, p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (!(e instanceof VerifyError)) throw e;
    unplaced(trade, step, e.message);
    return null;
  }
}

const termsOf = (t: TradeRow) => expectedTerms({ buyer: t.buyer, seller: t.seller, amount: t.amount, escrowAdmin: t.escrowAdmin! });

/**
 * Step 1 (FIXES F-02): the prepared escrow exists, so its creation key's
 * deploy is searched for and checked as escrow.recordCreate checks it.
 */
async function recordCreate(db: Database, t: TradeRow, escrow: Escrow): Promise<TradeRow> {
  const contractId = t.escrowContractId!;
  if (TW_FACTORY_CONTRACT_ID === null || TW_ESCROW_WASM_HASH === null) return unplaced(t, "create", "Trustless Work's escrow code is not pinned.");
  // The creation account is fresh, so its history is short; the trade's creation bounds it safely (escrow_prepared_at moves with every prepare).
  const hash = await findEscrowTx(t.escrowAdmin!, TW_FACTORY_CONTRACT_ID, "tw_new_single_release_escrow", t.createdAt);
  if (!hash) return unplaced(t, "create", "The escrow exists but its creation key's deploy was not found.");
  const terms = termsOf(t);
  const landed = await placed(t, "create", verifyEscrowTx(hash, { kind: "deploy", admin: t.escrowAdmin!, contractId, terms }));
  if (!landed) return t;
  const problems = checkEscrowTerms(escrow.terms, terms).map((p) => p.message);
  const wasm = await readWasmHash(contractId);
  if (wasm !== TW_ESCROW_WASM_HASH) problems.push(`It runs contract code ${wasm}, not Trustless Work's escrow.`);
  if (problems.length) return unplaced(t, "create", problems.join(" "));
  return transitionTrade(db, t.id, { type: "escrowCreate", by: "seller", contractId: landed.contractId, txHash: hash });
}

/** Step 2: a created escrow (or one whose trade was cancelled) that holds the amount was funded. */
async function recordFund(db: Database, t: TradeRow, status: EscrowStatus): Promise<TradeRow> {
  if (!fundedOnChain(status, t)) return t;
  const contractId = t.escrowContractId!;
  const hash = await findEscrowTx(t.seller, contractId, "fund_escrow", t.createdAt);
  if (!hash) return unplaced(t, "fund", "The escrow holds the amount but the seller's fund was not found.");
  const expected = { kind: "fund", contractId, seller: t.seller, amountStroops: toStroops(t.amount), terms: termsOf(t) } as const;
  const landed = await placed(t, "fund", verifyEscrowTx(hash, expected));
  if (!landed) return t;
  // After a cancel the fund is still the seller's USDC in the escrow: recorded, not refused (chain wins).
  return transitionTrade(db, t.id, { type: "fund", by: "seller", txHash: hash, fundedAt: landed.createdAt, reconcile: t.state === "cancelled" });
}

/** Step 3: a funded escrow was released, disputed, or resolved by the arbiter. */
async function recordSettlement(db: Database, t: TradeRow, status: EscrowStatus): Promise<TradeRow> {
  const contractId = t.escrowContractId!;
  const parties = { seller: t.seller, buyer: t.buyer };
  if (status.released) {
    const hash = await findEscrowTx(t.seller, contractId, "approve_and_release_milestones", t.createdAt);
    if (!hash) return unplaced(t, "release", "The escrow is released but the seller's release was not found.");
    if (!(await placed(t, "release", verifyEscrowTx(hash, { kind: "release", contractId, seller: t.seller })))) return t;
    return transitionTrade(db, t.id, { type: "release", by: "seller", txHash: hash });
  }
  let row = t;
  // A resolved escrow is no longer disputed on chain (dispute.resolved, not is_disputed), but it was.
  if (!row.disputed && (status.disputed || status.resolved)) {
    const found = await Promise.all([t.seller, t.buyer].map((p) => findEscrowTx(p, contractId, "dispute_escrow", t.createdAt)));
    const hashes = found.filter((h): h is string => h !== null);
    if (hashes.length !== 1) return unplaced(row, "dispute", `${hashes.length} disputes by the traders were found, not one.`);
    const landed = await placed(row, "dispute", verifyEscrowTx(hashes[0], { kind: "dispute", contractId, parties }));
    if (!landed) return row;
    // The 24 hours start now, when Pairy records it (DECISIONS 1): persist stamps dispute_recorded_at.
    const by = landed.signer === t.seller ? "seller" : "buyer";
    row = await transitionTrade(db, t.id, { type: "escrowDispute", by, txHash: hashes[0], disputedAt: landed.createdAt });
  }
  if (row.disputed && status.resolved) {
    const hash = await findEscrowTx(ARBITER_ACCOUNT, contractId, "resolve_dispute", t.createdAt);
    if (!hash) return unplaced(row, "resolve", "The escrow is resolved but the arbiter's resolution was not found.");
    const landed = await placed(row, "resolve", verifyEscrowTx(hash, { kind: "resolve", contractId, resolver: ARBITER_ACCOUNT, parties }));
    if (!landed?.payout) return row;
    const outcome = landed.payout.to === t.buyer ? "buyer" : "seller";
    row = await transitionTrade(db, t.id, { type: "resolve", by: "arbiter", outcome, txHash: hash, resolvedAt: landed.createdAt });
  }
  return row;
}

/** The sync, and the escrow as it read it (null: no contract there). */
async function syncWithChain(db: Database, trade: TradeRow): Promise<{ row: TradeRow; escrow: Escrow | null }> {
  // Marks the trade looked at, so the daily cron's third pass reaches the others first (FIXES F-12).
  const [stamped] = await db.update(trades).set({ lastSyncedAt: new Date() }).where(eq(trades.id, trade.id)).returning();
  let row: TradeRow = stamped ?? trade;
  if (row.escrowContractId === null || row.escrowAdmin === null) return { row, escrow: null };
  let escrow: Escrow;
  try {
    escrow = await readEscrow(row.escrowContractId);
  } catch (e) {
    // Not deployed (yet), or gone with a testnet reset. Any other error is an outage.
    if (e instanceof EscrowNotFoundError) return { row, escrow: null };
    throw e;
  }
  // O-23: no escrow is recorded on a cancelled trade; it has one already or never got one.
  if (row.state === "agreed") row = await recordCreate(db, row, escrow);
  if (row.state === "escrow_created" || (row.state === "cancelled" && row.createTx !== null && row.fundTx === null)) {
    row = await recordFund(db, row, escrow.status);
  }
  if (row.state === "funded") row = await recordSettlement(db, row, escrow.status);
  return { row, escrow };
}

/** Records whatever the trade's escrow shows on chain that the trade does not yet; see the top of this file. */
export async function syncProtectedTrade(db: Database, trade: TradeRow): Promise<TradeRow> {
  return (await syncWithChain(db, trade)).row;
}

/**
 * A prepared deploy is valid 300 s (Trustless Work), xdr.ts accepts up to
 * 60 s more, and Trustless Work answers at most 15 s after escrow_prepared_at
 * is stamped. After that the prepared deploy can no longer land.
 */
export const PREPARED_DEPLOY_VALID_MS = (300 + 60 + 15) * 1000;

const bad = (message: string) => new TRPCError({ code: "BAD_REQUEST", message });

/**
 * Before a protected trade is cancelled or expired, its escrow is checked on
 * chain and what the chain shows is recorded first (D2 §1.1, §4). Returns the
 * trade as synced when it may end; throws when it may not:
 * - funded on chain, recorded or not: the release or a dispute are the ways out;
 * - a prepared creation not recorded (O-23): only once the prepared deploy can
 *   no longer land and Soroban RPC shows no contract;
 * - the chain can't be read: refused, never guessed.
 */
export async function mayCancelProtected(db: Database, trade: TradeRow): Promise<TradeRow> {
  if (trade.state !== "escrow_created" && !(trade.state === "agreed" && trade.escrowContractId !== null)) return trade;
  let synced: Awaited<ReturnType<typeof syncWithChain>>;
  try {
    synced = await syncWithChain(db, trade);
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Couldn't check this trade's escrow on Stellar testnet. Try again in a minute.", cause: e });
  }
  const { row, escrow } = synced;
  const funded = "This escrow is already funded. A dispute is the way to a refund.";
  if (row.state === "agreed") {
    if (escrow) throw bad("This trade's escrow exists on Stellar testnet, so this page records it first. Try again in a minute.");
    if (Date.now() < (row.escrowPreparedAt?.getTime() ?? 0) + PREPARED_DEPLOY_VALID_MS) {
      throw bad("An escrow creation for this trade may still land on Stellar testnet. Try cancelling again in a few minutes.");
    }
    return row;
  }
  if (row.state === "escrow_created") {
    // No contract at all (a testnet reset) holds nothing either.
    if (escrow && fundedOnChain(escrow.status, row)) throw bad(funded);
    return row;
  }
  // The sync found the fund (or more): no cancel past funding.
  if (row.state !== "cancelled") throw bad(funded);
  return row;
}
