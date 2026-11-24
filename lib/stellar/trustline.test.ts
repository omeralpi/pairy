import { Account, Keypair, type Operation } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { toAsset } from "./assets";
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
});
