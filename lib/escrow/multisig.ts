// Collecting the arbiter's signatures on one prepared resolution. The resolve's
// source is the arbiter account and its authorization is the transaction's own
// (S-14, S-19), so each signer signs the same transaction hash in their own
// Freighter and the signatures sit side by side on the envelope. This module
// only reads and attaches signatures: it holds no key. A signature is public
// data, valid only on the exact transaction it was made for.
//
// FIXES F-04: envelope signatures only. S-19 landed a 2-of-2 resolve this way
// (13c43a45), so no address-credentials path is built.
//
// TODO(S-19/S-20, WP-15): Trustless Work's resolve is valid for 300 s, short for
// two signers on two computers. S-19 showed a resolve whose maxTime alone was
// rebuilt before anyone signed lands; whether Pairy does that is not decided.
// Until WP-15 decides, the hash these functions check is the one of the
// transaction as Trustless Work prepared it.

import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";

import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";

export type ArbiterSignature = { signer: string; signature: string };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The signatures in `signedXdr`, each checked against the prepared transaction's
 * hash and matched to one of `signers` (the arbiter account's current signers).
 * Throws when it is another transaction or a signature is from anyone else.
 */
export function extractSignatures(signedXdr: string, unsignedHashHex: string, signers: string[]): ArbiterSignature[] {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const hash = tx.hash();
  if (Buffer.from(hash).toString("hex") !== unsignedHashHex) {
    throw new Error("This was signed on a different transaction from the one prepared. Prepare it again and sign that one.");
  }
  const found = new Map<string, string>();
  for (const { hint, signature } of tx.signatures) {
    const signer = signers.find((s) => {
      const key = Keypair.fromPublicKey(s);
      return sameBytes(key.signatureHint(), hint.value) && signature.value.length === 64 && key.verify(hash, signature.value);
    });
    if (!signer) throw new Error("A signature on this transaction is not from one of the arbiter's signers.");
    found.set(signer, Buffer.from(signature.value).toString("base64"));
  }
  return [...found].map(([signer, signature]) => ({ signer, signature }));
}

/** The prepared transaction with these signatures attached, ready to send. */
export function mergeSignatures(unsignedXdr: string, sigs: ArbiterSignature[]): string {
  if (new Set(sigs.map((s) => s.signer)).size !== sigs.length) throw new Error("Each signer can sign only once.");
  const tx = TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE);
  // addSignature checks each signature against this transaction's hash and throws on one that does not match.
  for (const { signer, signature } of sigs) tx.addSignature(signer, signature);
  return tx.toXDR();
}
