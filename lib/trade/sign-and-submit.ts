// Client side of every settlement step. The transaction is signed by the
// user's own wallet and submitted from this browser straight to Horizon; the
// Pairy server only ever receives the resulting hash, which it then verifies.

import { Account, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";

import { loadAccount, submit } from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import type { Wallet } from "@/lib/wallet/use-wallet";

export async function signAndSubmit(wallet: Wallet, tx: Transaction): Promise<string> {
  const signed = await wallet.signTransaction(tx.toXDR());
  const res = await submit(TransactionBuilder.fromXDR(signed, NETWORK_PASSPHRASE) as Transaction);
  return res.hash;
}

/** The account's current sequence, as the source of a new transaction. */
export async function loadSourceAccount(publicKey: string): Promise<Account> {
  const account = await loadAccount(publicKey);
  if (!account) throw new Error("This account does not exist on testnet yet. Fund it with Friendbot first.");
  return new Account(account.accountId(), account.sequenceNumber());
}
