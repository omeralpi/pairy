'use client';

import type { Transaction } from "@stellar/stellar-sdk";
import { useState } from "react";

import { describeStellarError } from "@/lib/trade/stellar-errors";
import { signAndSubmit } from "@/lib/trade/sign-and-submit";
import type { Wallet } from "@/lib/wallet/use-wallet";

/**
 * build → sign on device → submit to Horizon → report the hash to Pairy. If
 * the transaction lands but reporting fails, the hash is kept so the report
 * can be retried without signing again.
 */
export function useChainStep(record: (txHash: string) => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreported, setUnreported] = useState<string | null>(null);

  async function report(hash: string) {
    try {
      await record(hash);
      setUnreported(null);
    } catch (e) {
      setUnreported(hash);
      setError(`The transaction is on-chain, but Pairy could not record it yet: ${describeStellarError(e)}`);
    }
  }

  async function run(wallet: Wallet, build: () => Promise<Transaction>) {
    setBusy(true);
    setError(null);
    try {
      const hash = await signAndSubmit(wallet, await build());
      await report(hash);
    } catch (e) {
      setError(describeStellarError(e));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!unreported) return;
    setBusy(true);
    setError(null);
    await report(unreported);
    setBusy(false);
  }

  return { busy, error, unreported, run, retry };
}
