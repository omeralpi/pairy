import { Account, Keypair, type Asset, type Operation } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { ASSETS, toAsset } from "./assets";
import { buildTrustlineTransaction } from "./trustline";

describe("buildTrustlineTransaction", () => {
  it("is one changeTrust op for the named asset from the given account", () => {
    const pk = Keypair.random().publicKey();
    const tx = buildTrustlineTransaction(new Account(pk, "5"), "USDC");
    expect(tx.source).toBe(pk);
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0] as Operation.ChangeTrust;
    expect(op.type).toBe("changeTrust");
    expect(op.line).toEqual(toAsset("USDC"));
  });

  it("trusts EURC from Circle's EURC issuer, not the USDC one", () => {
    const tx = buildTrustlineTransaction(new Account(Keypair.random().publicKey(), "5"), "EURC");
    const op = tx.operations[0] as Operation.ChangeTrust;
    expect(op.type).toBe("changeTrust");
    const line = op.line as Asset;
    expect(line.getCode()).toBe("EURC");
    expect(line.getIssuer()).toBe(ASSETS.EURC.issuer);
    expect(line.getIssuer()).not.toBe(ASSETS.USDC.issuer);
  });
});
