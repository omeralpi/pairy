// The escrow's creation key (PLAN I5). The seller's browser makes one per
// protected trade; it signs that escrow's deploy as its admin and is then
// dropped. It is never stored and never sent: this module hands out a signer
// whose key stays inside a closure, so no caller can read the secret. The
// key comes from Keypair.random(), whose entropy is WebCrypto's
// (`crypto.getRandomValues`), and the evidence scripts use this same code.

import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import type { Wallet } from "@/lib/wallet/use-wallet";

/** What signing and sending a transaction needs from a wallet. Moves to lib/trade/sign-and-submit.ts in WP-34. */
export type Signer = Pick<Wallet, "publicKey" | "signTransaction">;

/** A new key, as a signer. Signs on this device and sends nothing. */
export function makeCreationKey(): Signer {
  const key = Keypair.random();
  return {
    publicKey: key.publicKey(),
    signTransaction: async (xdr) => {
      const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
      tx.sign(key);
      return tx.toXDR();
    },
  };
}
