// Last checks before a settlement transaction is signed or sent. Each returns
// the reason to stop, in words the trader can act on, or null to go ahead.

import type { PreflightCheck } from "@/lib/trade/preflight";

/**
 * Re-read right before the lock is sent: the buyer may have cancelled, or
 * another tab may already have locked, while the signing prompt was open.
 */
export function lockGuard(state: string, checks: Pick<PreflightCheck, "id" | "ok">[]): string | null {
  if (state !== "agreed") {
    return `This trade is now ${state}, so the lock was not sent. Nothing left your wallet.`;
  }
  if (checks.some((c) => c.id === "noExistingLock" && !c.ok)) {
    return "This trade is already locked on Stellar, so a second lock was not sent. The page will show the existing lock.";
  }
  return null;
}

/**
 * Why the buyer's wallet cannot take the locked asset right now, from the
 * buyerTrustline preflight check, worded for the buyer. null when it can.
 * `code` is the operation result the claim would fail with.
 */
export function claimTrustlineProblem(
  checks: Pick<PreflightCheck, "id" | "ok" | "detail">[],
  asset: string,
): { code: string; message: string } | null {
  const c = checks.find((x) => x.id === "buyerTrustline");
  if (!c || c.ok) return null;
  const code = c.detail?.match(/\((op_\w+)\)/)?.[1] ?? "op_no_trust";
  if (code === "op_not_authorized") {
    return { code, message: `The ${asset} issuer has not authorized your ${asset} trustline, so the claim would fail (op_not_authorized).` };
  }
  if (code === "op_line_full") {
    return { code, message: `Your ${asset} trustline limit has no room for this amount. Raise the limit in your wallet, then claim (op_line_full).` };
  }
  return { code: "op_no_trust", message: `Add ${asset} to your wallet first. Without it the claim would fail (op_no_trust).` };
}

/**
 * A claim goes into the next ledger, about 5 seconds after it is sent, and the
 * chain refuses it once that ledger closes at or after the deadline. Claims
 * stop this long before the deadline so one sent at the last second does not
 * fail and still cost the fee.
 */
export const CLAIM_MARGIN_MS = 10_000;

export function claimClosesAt(buyerClaimUntil: number): number {
  return buyerClaimUntil - CLAIM_MARGIN_MS;
}

/**
 * The server's clock, read through the device's: claimWindow says what time
 * it was on the server when it answered (`serverNow`), and `receivedAt` is
 * the device time the answer arrived. A device clock minutes off would
 * otherwise move every countdown and button by that much (Q-17).
 */
export function serverClock(deviceNow: number, serverNow: number, receivedAt: number): number {
  return deviceNow + (serverNow - receivedAt);
}

/**
 * Whether the buyer may claim and the seller may reclaim, at `now` on the
 * server's clock. The server's own yes/no is required as well, so a clock
 * error can only ever close a button, never open one early.
 */
export function windowGates(
  w: { buyerCanClaim: boolean; buyerClaimUntil: number | null; sellerCanReclaim: boolean; sellerReclaimFrom: number | null },
  now: number,
) {
  const claimTooLate = w.buyerClaimUntil !== null && now >= claimClosesAt(w.buyerClaimUntil);
  return {
    claimOpen: w.buyerCanClaim && !claimTooLate,
    claimTooLate,
    reclaimOpen: w.sellerCanReclaim && (w.sellerReclaimFrom === null || now >= w.sellerReclaimFrom),
  };
}

/**
 * Why the seller must not press Lock again: a lock from this screen landed
 * but is not recorded yet (`unreported`), or this browser holds the hash of
 * a lock it sent for this trade. A second lock would be a second balance the
 * buyer can claim.
 */
export function unrecordedLock(unreported: string | null, pending: { kind: string } | null): string | null {
  if (unreported) return "Your lock is on Stellar but not recorded yet. Use Retry recording below; don't lock again.";
  if (pending?.kind === "lock") {
    return "You already sent a lock for this trade from this browser. Don't lock again: this page is recording it.";
  }
  return null;
}

export type BuyerClaim = { state: "open" | "closed" | "unknown" } | { state: "blocked"; reason: string };

/**
 * Whether a claim would work right now, for the buyer's headline: only then
 * is the buyer told to hand over the cash. `tooLate` is the 10 s cutoff on
 * the server's clock; `trust` and `wallet` are the reasons the claim screen
 * gives, or null.
 */
export function buyerClaim(input: {
  window: "open" | "closed" | "unknown";
  tooLate: boolean;
  trust: string | null;
  wallet: string | null;
}): BuyerClaim {
  if (input.window === "unknown") return { state: "unknown" };
  if (input.window === "closed" || input.tooLate) return { state: "closed" };
  const reason = input.trust ?? input.wallet;
  return reason ? { state: "blocked", reason } : { state: "open" };
}
