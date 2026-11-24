// The resolve's offline checks, on the buyer exit escrow-exits.ts recorded
// with the test 2-of-2 (tests/fixtures/tw/exits-test-resolve-buyer.json).

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readSignedCopy, rentProblem } from "./resolve-checks";

const r = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw/exits-test-resolve-buyer.json"), "utf8"));
const hash: string = r.rebuilt.txHash;
const signers: string[] = r.arbiter.signers;

describe("readSignedCopy", () => {
  it("reads both signatures from the merged envelope, and one from one signer's copy", () => {
    expect(readSignedCopy(r.landed.signedXdr, hash, signers)).toEqual({
      signatures: r.signatures.map(({ signer, signature }: { signer: string; signature: string }) => ({ signer, signature })),
      problem: null,
    });
    const alone = readSignedCopy(r.singleSignatures[1].envelopeXdr, hash, signers);
    expect(alone.problem).toBeNull();
    expect(alone.signatures.map((s) => s.signer)).toEqual([signers[1]]);
  });

  it("says so when the saved copy carries no signature, for example the unsigned resolve (N1)", () => {
    expect(readSignedCopy(r.rebuilt.unsignedXdr, hash, signers)).toEqual({
      signatures: [],
      problem: "no signature by an arbiter signer; is this the signed copy?",
    });
  });

  it("ignores another transaction, Trustless Work's own resolve included, and text that is not XDR", () => {
    expect(readSignedCopy(r.response.body.unsignedXdr, hash, signers).problem).toMatch(/different transaction/);
    expect(readSignedCopy("not a transaction", hash, signers).problem).toMatch(/Ignored; save a new copy/);
  });
});

describe("rentProblem (O-17)", () => {
  const latest: number = r.escrowTtl.latestLedger;

  it("lets the recorded escrow through: its rent is about 7 days away", () => {
    expect(rentProblem(r.escrowTtl.liveUntilLedgerSeq, latest)).toBeNull();
  });

  it("refuses while the 17,280-ledger extension point falls inside the window, and only then", () => {
    expect(rentProblem(latest + 17_279, latest)).toBeNull();
    expect(rentProblem(latest + 17_280, latest)).toMatch(/storage rent falls due in about 0 minutes; prepare after that/);
    expect(rentProblem(latest + 17_280 + 779, latest)).toMatch(/falls due in about 65 minutes/);
    expect(rentProblem(latest + 17_280 + 780, latest)).toBeNull();
  });

  it("fails closed when Soroban RPC gives no TTL for the entry (N4)", () => {
    expect(rentProblem(null, latest)).toMatch(/no storage TTL/);
  });
});
