// The arbiter pages' pure helpers (D2 §7.4): the browser's own check of a
// prepared resolution before the wallet signs it, against the escrow as this
// browser reads it from Soroban RPC, who may sign from this browser, how long
// a prepared transaction is still valid, and one press of Sign from the
// wallet's signature to the merged envelope this browser sends.

import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { friendlyError } from "@/components/friendly-error";
import { shortAddress } from "@/components/listing/format";
import { shortWhen } from "@/components/trade/format";
import type { useChainStep } from "@/components/trade/use-chain-step";
import type { RouterOutputs } from "@/lib/api";
import { ARBITER_ACCOUNT } from "@/lib/escrow/config";
import { ruleOutcome, type Answer } from "@/lib/escrow/rule";
import type { EscrowStatus, EscrowTerms } from "@/lib/escrow/terms";
import { decodeEscrowCall, describeEscrowCall, validateEscrowCall } from "@/lib/escrow/xdr";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import type { Signer } from "@/lib/trade/sign-and-submit";
import type { Wallet } from "@/lib/wallet/use-wallet";

export type Dispute = RouterOutputs["arbiter"]["byId"];
export type Prepared = RouterOutputs["arbiter"]["prepareResolution"];
export type Added = RouterOutputs["arbiter"]["addSignature"];

/** What the check needs of the dispute: the parties, the answers, and the escrow as Soroban RPC shows it now. */
type Checked = Pick<Dispute, "contractId" | "seller" | "buyer" | "ready"> & {
  answers: { seller: Answer; buyer: Answer };
  escrow: { status: { balanceStroops: bigint } } | null;
};

/**
 * DECISIONS 7 and O-17: this browser checks the re-timed resolve itself, right
 * before Varial opens. The payee comes from the rule applied to the two
 * answers here, never from the server; the amount is the escrow's USDC
 * balance (FIXES X-07), which signResolution reads from Soroban RPC itself;
 * the window must be the browser policy's 10 minutes to 24 hours. [] = safe
 * to sign, with the signing line.
 */
export function checkResolution(prepared: Pick<Prepared, "unsignedXdr" | "txHash">, dispute: Checked, now = new Date()): { problems: string[]; summary: string } {
  if (!dispute.ready) return { problems: ["The traders' answers are not final yet, so there is no outcome to sign."], summary: "" };
  if (!dispute.escrow || !dispute.contractId) {
    return { problems: ["The escrow could not be read from Stellar testnet, so the payout cannot be checked. Try again."], summary: "" };
  }
  const { outcome } = ruleOutcome(dispute.answers);
  const recipient = outcome === "buyer" ? dispute.buyer : dispute.seller;
  try {
    const decoded = decodeEscrowCall(prepared);
    const problems = validateEscrowCall(
      decoded,
      { kind: "resolve", contractId: dispute.contractId, resolver: ARBITER_ACCOUNT, recipient, amountStroops: dispute.escrow.status.balanceStroops, timePolicy: "browser-rebuilt" },
      now,
    );
    return { problems, summary: describeEscrowCall(decoded) };
  } catch (e) {
    return { problems: [`It could not be read as a transaction (${e instanceof Error ? e.message : String(e)}).`], summary: "" };
  }
}

/** The escrow as this browser reads it from Soroban RPC (lib/escrow/read.ts), never through Pairy's server. */
export type OnChain = { terms: Pick<EscrowTerms, "receiver" | "releaseSigners" | "disputeResolvers">; status: EscrowStatus };

/**
 * The escrow on chain against the dispute the server described. The payee
 * the rule picks must be one of this escrow's own parties (its receiver is
 * the buyer, its release signer the seller), the arbiter account must be its
 * resolver, and it must still be in dispute. [] = they agree.
 */
export function chainProblems(escrow: OnChain, d: Pick<Dispute, "seller" | "buyer">): string[] {
  const problems: string[] = [];
  if (escrow.terms.receiver !== d.buyer) {
    problems.push(`The escrow on chain names ${shortAddress(escrow.terms.receiver)} as its buyer, not ${shortAddress(d.buyer)}.`);
  }
  if (escrow.terms.releaseSigners[0] !== d.seller) {
    problems.push(`The escrow on chain names ${shortAddress(escrow.terms.releaseSigners[0] ?? "")} as its seller, not ${shortAddress(d.seller)}.`);
  }
  if (!escrow.terms.disputeResolvers.includes(ARBITER_ACCOUNT)) problems.push("The escrow on chain does not name the arbiter account as its dispute resolver.");
  if (escrow.status.resolved || escrow.status.released) problems.push("The escrow on chain is already settled; refresh the page.");
  else if (!escrow.status.disputed) problems.push("The escrow on chain is not in dispute.");
  return problems;
}

/**
 * The prepared resolution this page holds, while the server still shows it
 * as the trade's open one (or none yet, right after it was prepared). A
 * resolution only ever gains signatures, so whichever list is longer is the
 * current one: this page's own right after signing, the server's once
 * another signer signed.
 */
export function heldResolution(held: Prepared | null, open: { id: string; signers: string[] } | null): Prepared | null {
  if (!held || (open && open.id !== held.resolutionId)) return null;
  return open && open.signers.length > held.signers.length ? { ...held, signers: open.signers } : held;
}

/** After these sentences the held resolution is no longer the one to sign (FIXES F-03; arbiter.ts CLOSED and staleness). */
const DROPS = /prepare again|already sent|No such resolution|on Stellar testnet already|already settled/i;
export const dropsHeld = (sentence: string) => DROPS.test(sentence);

/** FIXES F-03: the last signer's send was refused by the network (or the server marked the row failed). */
export const NOT_ACCEPTED = "This prepared transaction was not accepted by the network; prepare again.";

/**
 * Why this browser cannot sign as `me`, or null. A signer signs in Varial
 * (formerly Freighter) on their own computer (SOW acceptance item 2, FIXES
 * F-04: the envelope path), with the account they signed in with.
 */
export function signerProblem(wallet: Wallet | null, ready: boolean, me: string): string | null {
  if (!ready) return "Loading your wallet…";
  if (!wallet || wallet.kind !== "freighter") return "Sign with Varial (formerly Freighter) on your own computer.";
  if (wallet.publicKey !== me) return `Varial (formerly Freighter) is on ${shortAddress(wallet.publicKey)}, but you signed in as ${shortAddress(me)}. Switch it to that account.`;
  return null;
}

/** The browser signs nothing in the last ten minutes of a resolve's window (O-17's floor, lib/escrow/xdr.ts REBUILT_MIN_S). */
export const SIGNING_FLOOR_MS = 10 * 60_000;

const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * "valid until hh:mm" (O-17), when signatures are last taken, and what is left.
 * Signing closes ten minutes before maxTime: the browser refuses a shorter
 * window, so the last signer has time to send.
 */
export function validity(expiresAt: Date, now: number): { until: string; signUntil: string; left: string; closing: boolean; expired: boolean } {
  const until = hhmm(expiresAt);
  const signUntil = hhmm(new Date(expiresAt.getTime() - SIGNING_FLOOR_MS));
  if (expiresAt.getTime() <= now) return { until, signUntil, left: "expired", closing: true, expired: true };
  const ms = expiresAt.getTime() - SIGNING_FLOOR_MS - now;
  if (ms <= 0) return { until, signUntil, left: "signing closed", closing: true, expired: false };
  const minutes = Math.floor(ms / 60_000);
  return { until, signUntil, left: minutes < 1 ? "less than a minute left" : `about ${minutes} minute${minutes === 1 ? "" : "s"} left`, closing: false, expired: false };
}

/**
 * A refusal in words. WP-29 N3: once a signer is removed from the account, the
 * stored signatures no longer check out and every later signature on that
 * resolution is refused until it expires by its maxTime.
 */
export function failureSentence(e: unknown, expiresAt?: Date): string {
  const message = typeof e === "object" && e !== null && "message" in e && typeof e.message === "string" ? friendlyError(e as { message: string }) : "Something went wrong.";
  if (expiresAt && /not from one of the arbiter's signers/.test(message)) {
    return `${message} A signer was removed from the arbiter account while this resolution was being signed; prepare again after it expires at ${shortWhen(expiresAt)}.`;
  }
  return message;
}

/** After a signature that was not the last one (D2 §7.4). */
export function handoffSentence(a: Pick<Added, "signerCount" | "threshold">): string {
  return `${a.signerCount} of ${a.threshold}. Ask the other signer${a.threshold - a.signerCount > 1 ? "s" : ""} to open this page.`;
}

/**
 * One press of Sign. This browser reads the escrow from Soroban RPC itself
 * and re-checks the resolve against it and the O-17 window, the wallet signs
 * it, and the server adds this signer's signature (O-31: only the caller's
 * own). Returns the signatures so far. When this was the last one, this
 * browser also sends the envelope the server merged, through `run`
 * (useChainStep: pending `resolve`, Horizon, then recordResolution), calling
 * `onSend` once nothing can stop the send. The server never submits.
 */
export async function signResolution(p: {
  prepared: Pick<Prepared, "resolutionId" | "unsignedXdr" | "txHash">;
  dispute: Omit<Checked, "escrow">;
  wallet: Wallet;
  readEscrow: (contractId: string) => Promise<OnChain>;
  addSignature: (input: { resolutionId: string; signedXdr: string }) => Promise<Added>;
  run: ReturnType<typeof useChainStep>["run"];
  onSend?: () => void;
  now?: Date;
}): Promise<Added> {
  let escrow: OnChain | null = null;
  if (p.dispute.contractId) {
    try {
      escrow = await p.readEscrow(p.dispute.contractId);
    } catch {
      throw new Error("Couldn't read the escrow from Stellar testnet, so this browser can't check the payout. Try again.");
    }
  }
  const onChain = escrow ? chainProblems(escrow, p.dispute) : [];
  const check = onChain.length ? { problems: onChain, summary: "" } : checkResolution(p.prepared, { ...p.dispute, escrow }, p.now);
  if (check.problems.length) throw new Error(`This browser won't sign it: ${check.problems.join(" ")}`);

  const signed = await p.wallet.signTransaction(p.prepared.unsignedXdr, { summary: check.summary });
  const added = await p.addSignature({ resolutionId: p.prepared.resolutionId, signedXdr: signed });
  if (added.signerCount < added.threshold) return added;

  // The last signature: the merged envelope is already signed, so the "signer"
  // only hands it over; signAndSubmit hashes it, checks it and sends it.
  const merged: Signer = { publicKey: ARBITER_ACCOUNT, signTransaction: async () => added.signedXdr };
  await p.run(merged, async () => TransactionBuilder.fromXDR(p.prepared.unsignedXdr, NETWORK_PASSPHRASE) as Transaction, {
    summary: check.summary,
    beforeSubmit: (hash) => {
      if (hash !== p.prepared.txHash) throw new Error("The merged resolution is not the transaction this page checked. Nothing was sent.");
      p.onSend?.();
    },
  });
  return added;
}
