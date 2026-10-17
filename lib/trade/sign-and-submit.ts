// Client side of every settlement step. The transaction is signed by the
// user's own wallet and submitted from this browser straight to Horizon; the
// Pairy server only ever receives the resulting hash, which it then verifies.

import { Account, NetworkError, TransactionBuilder, TransactionFailedError, type Transaction } from "@stellar/stellar-sdk";

import { loadAccount, submit } from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import type { Wallet } from "@/lib/wallet/use-wallet";

/** Horizon gave no verdict (a 504, a 5xx, a dropped connection): the network may still apply it. */
export const MAYBE_SENT =
  "Stellar testnet didn't confirm this in time, but it may still go through. Don't send it again yet: this page checks the ledger and updates once it lands.";

export type SubmitOptions = {
  /** Aborting it cancels an open pincode prompt, and a signature that comes back late is never sent. */
  signal?: AbortSignal;
  /** One line shown in the pincode dialog: what is being signed. */
  summary?: string;
  /** Runs after signing and before sending, with the signed hash. Throw to stop the send. */
  beforeSubmit?: (hash: string) => Promise<void> | void;
  /** Runs once nothing can stop the send any more, right before it. */
  onSending?: (hash: string) => void;
};

export async function signAndSubmit(wallet: Wallet, tx: Transaction, opts: SubmitOptions = {}): Promise<string> {
  const signed = await wallet.signTransaction(tx.toXDR(), { signal: opts.signal, summary: opts.summary });
  if (opts.signal?.aborted) throw new Error("Signing cancelled. Nothing was sent.");
  const ready = TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE) as Transaction;
  const hash = Array.from(ready.hash(), (b) => b.toString(16).padStart(2, "0")).join("");
  await opts.beforeSubmit?.(hash);
  if (opts.signal?.aborted) throw new Error("Signing cancelled. Nothing was sent.");
  opts.onSending?.(hash);
  try {
    const res = await submit(ready);
    return res.hash;
  } catch (e) {
    // Refused with result codes, or turned away by Horizon itself (4xx): it never applied.
    const status = e instanceof NetworkError ? e.getResponse().status : undefined;
    if (e instanceof TransactionFailedError || (status !== undefined && status < 500)) throw e;
    throw new Error(MAYBE_SENT);
  }
}

/** The account's current sequence, as the source of a new transaction. */
export async function loadSourceAccount(publicKey: string): Promise<Account> {
  const account = await loadAccount(publicKey);
  if (!account) throw new Error("This account does not exist on testnet yet. Fund it with Friendbot first.");
  return new Account(account.accountId(), account.sequenceNumber());
}
