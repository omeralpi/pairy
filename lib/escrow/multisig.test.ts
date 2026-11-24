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

/** The transaction-level result code in a Horizon result_xdr, e.g. "txBadAuth". */
const resultCode = (resultXdr: string) => xdr.TransactionResult.fromXDR(resultXdr, "base64").result.type;

describe("one signature alone is not enough (S-19)", () => {
  it("each signer's envelope carries one signature on the hash that later landed, and was refused with tx_bad_auth outside any ledger", () => {
    for (const sig of [one, two]) {
      const alone = mergeSignatures(unsignedXdr, [sig]);
      expect(Buffer.from(TransactionBuilder.fromXDR(alone, Networks.TESTNET).hash()).toString("hex")).toBe(s19.twoSignatures.submit.hash);
      expect(extractSignatures(alone, unsignedHash, SIGNERS)).toEqual([sig]);
    }
    for (const attempt of s19.singleSignature) {
      expect(attempt.codes).toEqual(["tx_bad_auth"]);
      expect(resultCode(attempt.resultXdr)).toBe("txBadAuth");
      expect(attempt.inLedger).toBe(false);
    }
  });
});

// WP-15: recorded by scripts/evidence/escrow-exits.ts dispute-<side> --arbiter=test.
describe.each(["buyer", "seller"])("the arbiter's signatures on the dispute exit to the %s (WP-15, test 2-of-2)", (side) => {
  const r = read(`exits-test-resolve-${side}`);
  const sigs = (r.signatures as { signer: string; signature: string }[]).map(({ signer, signature }) => ({ signer, signature }));

  it("merge, from two signatures made apart on the re-timed resolve, into the envelope that landed", () => {
    expect(sigs).toHaveLength(2);
    expect(mergeSignatures(r.rebuilt.unsignedXdr, sigs)).toBe(r.landed.signedXdr);
    expect(extractSignatures(r.landed.signedXdr, r.rebuilt.txHash, r.arbiter.signers)).toEqual(sigs);
  });

  it("do not count against Trustless Work's original hash (O-17)", () => {
    expect(() => extractSignatures(r.landed.signedXdr, r.response.body.txHash, r.arbiter.signers)).toThrow(/different transaction/);
  });

  it("each alone is not enough: that envelope was refused with tx_bad_auth outside any ledger, and the arbiter's sequence did not move", () => {
    expect(r.arbiter.thresholds).toEqual({ low: 2, med: 2, high: 2 });
    expect(r.singleSignatures.map((s: { signer: string }) => s.signer)).toEqual(sigs.map((s) => s.signer));
    sigs.forEach((sig, i) => {
      const refused = r.singleSignatures[i];
      expect(mergeSignatures(r.rebuilt.unsignedXdr, [sig])).toBe(refused.envelopeXdr);
      expect(refused.hash).toBe(r.landed.hash);
      expect(refused.codes).toEqual(["tx_bad_auth"]);
      expect(resultCode(refused.resultXdr)).toBe("txBadAuth");
      expect(refused.inLedger).toBe(false);
      expect(refused.arbiterSequenceAfter).toBe(r.arbiter.sequence);
    });
  });
});
