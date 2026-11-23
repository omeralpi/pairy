// The S-19 probe's real 2-of-2 resolve: Trustless Work's unsigned XDR, each
// signer's signature made on its own copy, and the merged envelope that landed
// on testnet (13c43a45…). One signature alone was refused there (tx_bad_auth).

import { readFileSync } from "node:fs";
import path from "node:path";

import { Keypair, Networks, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { extractSignatures, mergeSignatures } from "./multisig";

const read = (name: string) => JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw", `${name}.json`), "utf8"));
const s19 = read("s19-resolve-buyer");
const unsignedXdr: string = s19.response.body.unsignedXdr;
const unsignedHash: string = s19.response.body.txHash;
const merged: string = s19.twoSignatures.mergedSignedXdr;
const [one, two] = (s19.twoSignatures.signatures as { signer: string; signature: string }[]).map(({ signer, signature }) => ({
  signer,
  signature,
}));
const SIGNERS = [s19.arbiter.signer1, s19.arbiter.signer2];

describe("mergeSignatures", () => {
  it("rebuilds, from two signatures made apart, the envelope that landed on testnet", () => {
    expect(mergeSignatures(unsignedXdr, [one, two])).toBe(merged);
  });

  it("keeps the transaction's hash", () => {
    const tx = TransactionBuilder.fromXDR(mergeSignatures(unsignedXdr, [one]), Networks.TESTNET);
    expect(Buffer.from(tx.hash()).toString("hex")).toBe(unsignedHash);
    expect(tx.signatures).toHaveLength(1);
  });

  it("refuses a signature that is not that signer's signature on this transaction", () => {
    expect(() => mergeSignatures(unsignedXdr, [{ signer: two.signer, signature: one.signature }])).toThrow();
    const other = read("resolve-dispute").response.body.unsignedXdr;
    expect(() => mergeSignatures(other, [one])).toThrow();
  });

  it("refuses the same signer twice", () => {
    expect(() => mergeSignatures(unsignedXdr, [one, one])).toThrow(/once/);
  });
});

describe("extractSignatures", () => {
  it("lifts both verified signatures out of the merged envelope", () => {
    expect(extractSignatures(merged, unsignedHash, SIGNERS)).toEqual([one, two]);
  });

  it("lifts one signer's signature out of that signer's own copy", () => {
    expect(extractSignatures(mergeSignatures(unsignedXdr, [two]), unsignedHash, SIGNERS)).toEqual([two]);
  });

  it("finds nothing on the unsigned envelope", () => {
    expect(extractSignatures(unsignedXdr, unsignedHash, SIGNERS)).toEqual([]);
  });

  it("throws on a different transaction", () => {
    const other = read("resolve-dispute").response.body.unsignedXdr;
    expect(() => extractSignatures(other, unsignedHash, SIGNERS)).toThrow(/different transaction/);
  });

  it("throws on a signature from a key that is not one of the signers", () => {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
    tx.sign(Keypair.random());
    expect(() => extractSignatures(tx.toXDR(), unsignedHash, SIGNERS)).toThrow(/not from one of/);
    // A signer removed from the arbiter account no longer counts.
    expect(() => extractSignatures(merged, unsignedHash, [one.signer])).toThrow(/not from one of/);
  });

  it("throws on a forged signature that carries a signer's hint", () => {
    const tx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
    tx.addDecoratedSignature(
      new xdr.DecoratedSignature({ hint: Keypair.fromPublicKey(one.signer).signatureHint(), signature: new Uint8Array(64).fill(7) }),
    );
    expect(() => extractSignatures(tx.toXDR(), unsignedHash, SIGNERS)).toThrow(/not from one of/);
  });
});
