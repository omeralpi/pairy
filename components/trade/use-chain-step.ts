'use client';

import { TransactionFailedError, type Transaction } from "@stellar/stellar-sdk";
import { useEffect, useRef, useState } from "react";

import type { AssetCode } from "@/lib/stellar/assets";
import { clearPendingTx, savePendingTx, setStepRunning, type PendingTx } from "@/lib/trade/pending-tx";
import { describeStellarError } from "@/lib/trade/stellar-errors";
import { signAndSubmit, type Signer, type SubmitOptions } from "@/lib/trade/sign-and-submit";

/**
 * build → sign on device → submit to Horizon → report the hash to Pairy. If
 * the transaction lands but reporting fails, the hash is kept so the report
 * can be retried without signing again. With `pending`, the signed hash is
 * also kept in this browser until it is recorded, so a reload can report it;
 * while this step sends and records it, useTradeSync leaves it to the step.
 * Leaving the screen cancels a signature still being asked for.
 */
export function useChainStep(
  record: (txHash: string) => Promise<unknown>,
  pending?: { tradeId: string; kind: PendingTx["kind"] },
  /** The asset the step moves, so a trustline refusal can name it. */
  asset?: AssetCode,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreported, setUnreported] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  async function report(hash: string) {
    try {
      await record(hash);
      setUnreported(null);
      if (pending) clearPendingTx(pending.tradeId);
    } catch (e) {
      setUnreported(hash);
      setError(`It went through on Stellar testnet, but Pairy could not record it yet: ${describeStellarError(e, asset)}`);
    }
  }

  async function run(
    signer: Signer,
    build: () => Promise<Transaction>,
    opts: Pick<SubmitOptions, "summary" | "beforeSubmit"> = {},
  ) {
    setBusy(true);
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const hash = await signAndSubmit(signer, await build(), {
        ...opts,
        signal: controller.signal,
        // Kept only once the send is certain, so an aborted step leaves nothing to retry.
        onSending: (signedHash) => {
          if (!pending) return;
          savePendingTx(pending.tradeId, { kind: pending.kind, hash: signedHash });
          setStepRunning(pending.tradeId, true);
        },
      });
      await report(hash);
    } catch (e) {
      // The network refused it outright, so there is nothing to record later.
      if (pending && e instanceof TransactionFailedError) clearPendingTx(pending.tradeId);
      if (!controller.signal.aborted) setError(describeStellarError(e, asset));
    } finally {
      if (pending) setStepRunning(pending.tradeId, false);
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function retry() {
    if (!unreported) return;
    setBusy(true);
    setError(null);
    if (pending) setStepRunning(pending.tradeId, true);
    await report(unreported);
    if (pending) setStepRunning(pending.tradeId, false);
    setBusy(false);
  }

  return { busy, error, unreported, run, retry };
}
