'use client';

import { useEffect } from "react";

import type { TradeView } from "@/components/trade/format";
import { api } from "@/lib/api";
import { PENDING_TX_MAX_AGE_MS, clearPendingTx, pendingTxAction, readPendingTx } from "@/lib/trade/pending-tx";

const SYNC_EVERY_MS = 20_000;

/**
 * How long after a cancel the server still looks for a lock that raced it.
 * Same value as CANCEL_LOCK_GRACE_MS in lib/trade/sync.ts, which cannot be
 * imported here: that module pulls in the database.
 */
export const CANCEL_LOCK_GRACE_MS = 15 * 60 * 1000;

/**
 * A lock or claim may be on the ledger without Pairy knowing (Q-1, Q-2). A
 * trade cancelled before it was agreed can never have been locked, and after
 * the grace period the server no longer looks for one, unless this browser
 * holds the hash of a lock it sent (`pendingLock`): that one is still
 * reported, as recordLock accepts it at any time.
 */
export function needsSync(
  t: Pick<TradeView, "state" | "balanceId" | "events">,
  now: number = Date.now(),
  pendingLock = false,
): boolean {
  if (t.state === "cancelled") {
    if (!t.balanceId && pendingLock) return true;
    const cancel = t.events.filter((e) => e.type === "cancel" || e.type === "expire").at(-1);
    return (
      !t.balanceId &&
      t.events.some((e) => e.type === "agree") &&
      !!cancel &&
      now < cancel.createdAt.getTime() + CANCEL_LOCK_GRACE_MS
    );
  }
  return t.state === "agreed" || t.state === "locked";
}

/**
 * Keeps the trade in line with the ledger while it is open: first reports a
 * hash this browser signed but never got recorded, then asks the server to
 * look on Horizon for a lock or claim it missed. Runs on load and every 20 s.
 */
export function useTradeSync(trade: TradeView) {
  const utils = api.useUtils();
  const { mutateAsync: sync } = api.trade.sync.useMutation();
  const { mutateAsync: recordLock } = api.trade.recordLock.useMutation();
  const { mutateAsync: recordClaim } = api.trade.recordClaim.useMutation();
  const { id } = trade;
  const active = needsSync(trade, Date.now(), readPendingTx(id)?.kind === "lock");

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function tick() {
      const current = utils.trade.byId.getData({ id });
      // The grace period can run out while the page sits open.
      if (current && !needsSync(current, Date.now(), readPendingTx(id)?.kind === "lock")) {
        clearInterval(timer);
        return;
      }
      const pending = readPendingTx(id);
      if (pending && current) {
        if (pendingTxAction(current, pending) === "clear") {
          clearPendingTx(id);
        } else {
          try {
            const report = pending.kind === "lock" ? recordLock : recordClaim;
            await report({ tradeId: id, txHash: pending.hash });
            clearPendingTx(id);
          } catch {
            // Not on the ledger (yet), or already recorded by the sync below.
            if (Date.now() - pending.savedAt > PENDING_TX_MAX_AGE_MS) clearPendingTx(id);
          }
        }
      }
      if (stopped) return;
      // Horizon or Pairy unreachable: the next tick tries again.
      await sync({ tradeId: id }).catch(() => undefined);
      if (!stopped) await utils.trade.invalidate();
    }

    timer = setInterval(() => void tick(), SYNC_EVERY_MS);
    void tick();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, id, utils, sync, recordLock, recordClaim]);
}
