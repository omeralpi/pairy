import { Account, Keypair, type Operation } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { toAsset } from "./assets";
import { buildUsdcTrustlineTransaction } from "./trustline";

describe("buildUsdcTrustlineTransaction", () => {
  it("is one changeTrust op for testnet USDC from the given account", () => {
    const pk = Keypair.random().publicKey();
    const tx = buildUsdcTrustlineTransaction(new Account(pk, "5"));
    expect(tx.source).toBe(pk);
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0] as Operation.ChangeTrust;
    expect(op.type).toBe("changeTrust");
    expect(op.line).toEqual(toAsset("USDC"));
  });
});
