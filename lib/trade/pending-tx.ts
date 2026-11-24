// A signed lock or claim, or a protected trade's escrow creation, fund or
// release, whose hash Pairy has not recorded yet, kept in this browser so a
// reload, a closed tab or a failed request does not lose it. The hash is
// public data; no key or signature is stored. Every storage access is
// guarded: blocked storage (private mode, some WebViews) just means no retry.

const KINDS = ["lock", "claim", "create", "fund", "release"] as const;

export type PendingTx = { kind: (typeof KINDS)[number]; hash: string; savedAt: number };

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
      KINDS.some((k) => k === v.kind) &&
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

// The trades whose step this page is sending or recording now, from the
// moment its hash is kept until it is recorded or fails. Meanwhile that hash
// is the step's to report, not useTradeSync's, so each record is sent once
// (WP-34 judge N1). Kept in memory only: after a reload, or in another tab,
// no step runs and the hook reports the hash as before.
const running = new Set<string>();

export function setStepRunning(tradeId: string, on: boolean) {
  if (on) running.add(tradeId);
  else running.delete(tradeId);
}

export function stepRunning(tradeId: string): boolean {
  return running.has(tradeId);
}

/**
 * What to do with a stored hash given the trade as Pairy has it: report it,
 * drop it (already recorded, or no longer needed), or leave it alone.
 */
export function pendingTxAction(
  trade: {
    state: string;
    lockTx: string | null;
    claimTx: string | null;
    reclaimTx: string | null;
    createTx: string | null;
    fundTx: string | null;
    releaseTx: string | null;
  },
  pending: PendingTx,
): "record" | "clear" {
  switch (pending.kind) {
    case "lock":
      return trade.lockTx === null ? "record" : "clear";
    case "claim":
      return trade.state === "locked" && trade.claimTx === null && trade.reclaimTx === null ? "record" : "clear";
    // escrow.recordCreate takes a creation only while the trade is agreed.
    case "create":
      return trade.state === "agreed" && trade.createTx === null ? "record" : "clear";
    // A fund that lands after a cancel is still recorded: the chain wins.
    case "fund":
      return trade.createTx !== null && trade.fundTx === null && (trade.state === "escrow_created" || trade.state === "cancelled")
        ? "record"
        : "clear";
    case "release":
      return trade.state === "funded" && trade.releaseTx === null ? "record" : "clear";
  }
}
