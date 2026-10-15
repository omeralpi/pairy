// STUB — replaced by the settlement agent. Signatures are the contract the
// trade router relies on; keep them.
//
// The server never trusts a client-reported state change: it reads the
// transaction back from Horizon and checks it against what the trade says.

import type { AssetCode } from "./assets";

export type ExpectedLock = {
  seller: string;
  buyer: string;
  asset: AssetCode;
  /** Decimal string as stored on the trade, e.g. "25.5000000". */
  amount: string;
  windowSeconds: number;
};

/**
 * Confirms `hash` is a successful testnet tx whose only op is a
 * createClaimableBalance from `seller` with exactly the two Pairy claimants.
 * Returns the created balance ID. Throws with a human-readable reason otherwise.
 */
export async function verifyLockTx(
  _hash: string,
  _expected: ExpectedLock,
): Promise<{ balanceId: string }> {
  throw new Error("verifyLockTx not implemented");
}

/**
 * Confirms `hash` is a successful testnet tx that claimed `balanceId`.
 * Returns which account claimed it (buyer → claimed, seller → reclaimed).
 */
export async function verifyClaimTx(
  _hash: string,
  _balanceId: string,
): Promise<{ claimant: string }> {
  throw new Error("verifyClaimTx not implemented");
}
