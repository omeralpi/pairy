// Reads a protected trade's escrow transactions back from Horizon by hash,
// the way lib/stellar/verify.ts reads a lock: the server records an escrow
// step only after it has seen the transaction on chain (PLAN I9). Horizon has
// no result meta (FIXES F-02), so the check is the envelope plus the
// operation record: the envelope must pass the same validateEscrowCall the
// server ran before anyone signed, as of its ledger's close time, and
// Horizon's operation record must name the same contract and function. The
// USDC it moved comes from that record's asset_balance_changes (FIXES X-09).
// A dispute is the exception: it is recorded whoever built it, so it is
// checked for what it did (disputeProblems below).
// Public data only; nothing here signs.

import { NotFoundError, scValToNative, xdr, type Horizon } from "@stellar/stellar-sdk";

import { ASSETS } from "@/lib/stellar/assets";
import { horizon } from "@/lib/stellar/horizon";
import { VerifyError, loadSuccessfulTx } from "@/lib/stellar/verify";
import { toStroops } from "@/lib/trade/amount";

import { decodeEscrowCall, deriveEscrowId, validateEscrowCall, type CallExpectation, type DecodedCall } from "./xdr";

/** The transaction is not this trade's escrow step. */
export class EscrowMismatchError extends VerifyError {}

/** A trade's two traders. */
type Parties = { seller: string; buyer: string };

/** The escrow steps the server records from the chain. */
export type ExpectedEscrowTx =
  | Extract<CallExpectation, { kind: "deploy" | "fund" | "release" }>
  /** Either trader may open the dispute; the transaction says which (D2 §2). */
  | { kind: "dispute"; contractId: string; parties: Parties }
  /** The arbiter pays the whole escrow to one of the two traders; which one is the outcome (D2 §4.1). */
  | { kind: "resolve"; contractId: string; resolver: string; parties: Parties };

/** A USDC transfer the call made, from Horizon's operation record. */
export type EscrowTransfer = { from: string; to: string; amountStroops: bigint };

const STEP: Record<ExpectedEscrowTx["kind"], string> = {
  deploy: "escrow creation",
  fund: "escrow funding",
  release: "escrow release",
  dispute: "escrow dispute",
  resolve: "dispute resolution",
};

const traders = (p: Parties) => [p.seller, p.buyer];

/**
 * A landed dispute is recorded whoever built it: a dispute opened outside
 * Pairy's app counts from when Pairy finds it (D2 §13, docs/arbitration.md),
 * or it would hold the escrow with nobody told. So it is checked for what it
 * did: one call of dispute_escrow on this escrow, by one of the two traders
 * for themselves. Pairy's reason, the fee cap and the five-minute validity
 * protect a signer before signing; they change nothing once it has landed.
 */
function disputeProblems(d: DecodedCall, e: { contractId: string; parties: Parties }): string[] {
  const problems: string[] = [];
  if (d.opCount !== 1 || d.opType !== "invokeHostFunction") problems.push("It is not one contract call.");
  if (d.contractId !== e.contractId) problems.push(`It calls contract ${d.contractId || "none"}, not ${e.contractId}.`);
  if (d.fn !== "dispute_escrow") problems.push(`It calls ${d.fn || "nothing"}, not dispute_escrow.`);
  if (!traders(e.parties).includes(d.source)) problems.push(`It was sent from ${d.source}, who is not one of this trade's traders.`);
  if (d.args[0] !== d.source) problems.push("It disputes for another account than the one that sent it.");
  return problems;
}

/** Who a resolution pays: its distribution's one entry, when that is one of the two traders. */
function payoutOf(d: DecodedCall, p: Parties): { to: string; amountStroops: bigint } | null {
  const v = d.args[2];
  const pays = v !== null && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : [];
  const [to, amountStroops] = pays.length === 1 ? pays[0] : [];
  return typeof to === "string" && typeof amountStroops === "bigint" && traders(p).includes(to) ? { to, amountStroops } : null;
}

type InvokeRecord = Horizon.ServerApi.InvokeHostFunctionOperationRecord;

/** The contract and function an invoke_host_function record names: parameters[0] and [1] (its `address` is ""). */
function calledBy(op: Pick<InvokeRecord, "parameters">): [unknown, unknown] {
  const [contract, fn] = (op.parameters ?? []).slice(0, 2).map((p) => scValToNative(xdr.ScVal.fromXDR(p.value, "base64")));
  return [contract, fn];
}

function usdcTransfers(op: InvokeRecord): EscrowTransfer[] {
  // Horizon sends null for a call that moved nothing (a deploy).
  const changes: Horizon.HorizonApi.BalanceChange[] = op.asset_balance_changes ?? [];
  return changes
    .filter((c) => c.type === "transfer" && c.asset_code === "USDC" && c.asset_issuer === ASSETS.USDC.issuer)
    .map((c) => ({ from: c.from, to: c.to, amountStroops: toStroops(c.amount) }));
}

/**
 * Confirms `hash` is a successful testnet transaction that is this trade's
 * escrow step, as `e` describes it. Throws EscrowMismatchError when it is
 * another transaction, VerifyError when it is missing or failed, and lets a
 * Horizon outage through as itself. `contractId` is the escrow (for a deploy,
 * the one it created); `signer` is who sent it (for a dispute, the trader who
 * opened it); `payout`, for a resolution only, is whom it paid and how much.
 */
export async function verifyEscrowTx(
  hash: string,
  e: ExpectedEscrowTx,
): Promise<{ createdAt: Date; signer: string; contractId: string; transfers: EscrowTransfer[]; payout?: { to: string; amountStroops: bigint } }> {
  const { tx, createdAt } = await loadSuccessfulTx(hash);
  const step = STEP[e.kind];
  const landed = decodeEscrowCall({ unsignedXdr: tx.toXDR(), txHash: hash });
  const payout = e.kind === "resolve" ? payoutOf(landed, e.parties) : null;
  // As of its ledger's close time: that is when its time bounds were checked by the network.
  const problems =
    e.kind === "dispute"
      ? disputeProblems(landed, e)
      : e.kind !== "resolve"
        ? validateEscrowCall(landed, e, createdAt)
        : payout
          ? validateEscrowCall(landed, { ...e, recipient: payout.to, amountStroops: payout.amountStroops, timePolicy: "landed" }, createdAt)
          : ["It does not pay the whole escrow to one of the trade's two traders."];
  if (problems.length) throw new EscrowMismatchError(`Transaction ${hash} is not this trade's ${step}: ${problems.join(" ")}`);

  const { records } = await horizon.operations().forTransaction(hash).call();
  const op = records[0];
  if (records.length !== 1 || op?.type !== "invoke_host_function") {
    throw new EscrowMismatchError(`Transaction ${hash} is not one contract call, so it is not this trade's ${step}.`);
  }
  const [contract, fn] = calledBy(op);
  if (contract !== landed.contractId || fn !== landed.fn) {
    throw new EscrowMismatchError(`Horizon records ${hash} as ${String(fn)} on ${String(contract)}, not ${landed.fn} on ${landed.contractId}.`);
  }
  const transfers = usdcTransfers(op);
  if (e.kind === "fund") {
    const [t] = transfers;
    if (transfers.length !== 1 || t.from !== e.seller || t.to !== e.contractId || t.amountStroops !== e.amountStroops) {
      throw new EscrowMismatchError(`Horizon does not show ${hash} moving the seller's USDC into the escrow.`);
    }
  }
  return {
    createdAt,
    signer: landed.source,
    contractId: e.kind === "deploy" ? deriveEscrowId(landed) : landed.contractId,
    transfers,
    ...(payout ? { payout } : {}),
  };
}

/** The most of an account's operations findEscrowTx reads back (10 pages of 200), as findLockTx does. */
const MAX_SEARCH_PAGES = 10;
const PAGE_SIZE = 200;

/**
 * The newest successful call of `fn` on `contractId` that `account` itself
 * made at or after `notBefore`, or null. Reads the account's operations
 * newest first and stops at notBefore or after 10 pages. Its result is a hash
 * to put through verifyEscrowTx, never a verdict on its own.
 */
export async function findEscrowTx(account: string, contractId: string, fn: string, notBefore: Date): Promise<string | null> {
  let page;
  try {
    page = await horizon.operations().forAccount(account).order("desc").limit(PAGE_SIZE).call();
  } catch (e) {
    // Horizon has no history for this account (never funded, or wiped by a testnet reset).
    if (e instanceof NotFoundError) return null;
    throw e;
  }
  for (let n = 1; ; n++) {
    for (const op of page.records) {
      if (new Date(op.created_at) < notBefore) return null;
      // Another account's call shows up here when it moved this account's USDC; only the account's own calls count.
      if (op.type !== "invoke_host_function" || !op.transaction_successful || op.source_account !== account) continue;
      const [c, f] = calledBy(op);
      if (c === contractId && f === fn) return op.transaction_hash;
    }
    if (page.records.length < PAGE_SIZE || n === MAX_SEARCH_PAGES) return null;
    page = await page.next();
  }
}
