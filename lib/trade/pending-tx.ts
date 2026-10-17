// A signed lock or claim whose hash Pairy has not recorded yet, kept in this
// browser so a reload, a closed tab or a failed request does not lose it. The
// hash is public data; no key or signature is stored. Every storage access is
// guarded: blocked storage (private mode, some WebViews) just means no retry.

export type PendingTx = { kind: "lock" | "claim"; hash: string; savedAt: number };

/** A signed transaction expires after its 300 s timeout; past this, sync on the server has the final say. */
export const PENDING_TX_MAX_AGE_MS = 15 * 60 * 1000;

const key = (tradeId: string) => `pairy:pending-tx:${tradeId}`;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function savePendingTx(tradeId: string, tx: Omit<PendingTx, "savedAt">, store = storage(), now = Date.now()) {
  try {
    store?.setItem(key(tradeId), JSON.stringify({ ...tx, savedAt: now }));
  } catch {
    // Storage full or blocked: the in-page retry and the server sync still work.
  }
}

export function readPendingTx(tradeId: string, store = storage()): PendingTx | null {
  try {
    const v = JSON.parse(store?.getItem(key(tradeId)) ?? "null") as Partial<PendingTx> | null;
    if (
      v &&
      (v.kind === "lock" || v.kind === "claim") &&
      typeof v.hash === "string" &&
      /^[0-9a-f]{64}$/i.test(v.hash) &&
      typeof v.savedAt === "number"
    ) {
      return v as PendingTx;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearPendingTx(tradeId: string, store = storage()) {
  try {
    store?.removeItem(key(tradeId));
  } catch {
    // Nothing to do: a stale entry is dropped by pendingTxAction later.
  }
}

/**
 * What to do with a stored hash given the trade as Pairy has it: report it,
 * drop it (already recorded, or no longer needed), or leave it alone.
 */
export function pendingTxAction(
  trade: { state: string; lockTx: string | null; claimTx: string | null; reclaimTx: string | null },
  pending: PendingTx,
): "record" | "clear" {
  if (pending.kind === "lock") return trade.lockTx === null ? "record" : "clear";
  return trade.state === "locked" && trade.claimTx === null && trade.reclaimTx === null ? "record" : "clear";
}
