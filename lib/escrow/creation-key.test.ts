// FIXES F-15 and PLAN I5: the module hands out a signer, never a key.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Keypair, Networks, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import * as creationKey from "./creation-key";
import { makeCreationKey } from "./creation-key";

const deploy = JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw/deploy.json"), "utf8")).response.body;

describe("creation key", () => {
  it("exports only makeCreationKey", () => {
    expect(Object.keys(creationKey)).toEqual(["makeCreationKey"]);
  });

  it("hands out a public key and a signing function, and nothing that holds a secret", () => {
    const signer = makeCreationKey();
    expect(Object.keys(signer)).toEqual(["publicKey", "signTransaction"]);
    expect(StrKey.isValidEd25519PublicKey(signer.publicKey)).toBe(true);
    expect(JSON.stringify(signer)).not.toMatch(/S[A-Z2-7]{55}/);
  });

  it("makes a new key every time", () => {
    expect(makeCreationKey().publicKey).not.toBe(makeCreationKey().publicKey);
  });

  it("signs a Trustless Work deploy with its own key", async () => {
    const signer = makeCreationKey();
    const tx = TransactionBuilder.fromXDR(await signer.signTransaction(deploy.unsignedXdr), Networks.TESTNET);
    expect(Buffer.from(tx.hash()).toString("hex")).toBe(deploy.txHash);
    expect(tx.signatures).toHaveLength(1);
    expect(Keypair.fromPublicKey(signer.publicKey).verify(tx.hash(), tx.signatures[0].signature.value)).toBe(true);
  });
});
