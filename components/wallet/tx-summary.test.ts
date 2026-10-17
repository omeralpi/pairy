import { Account, Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { toAsset } from "@/lib/stellar/assets";
import { buildClaimTransaction, buildLockTransaction } from "@/lib/stellar/settlement";
import { buildUsdcTrustlineTransaction } from "@/lib/stellar/trustline";

import { describeTransaction } from "./tx-summary";

const seller = Keypair.random().publicKey();
const buyer = Keypair.random().publicKey();
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;

describe("describeTransaction (Q-7)", () => {
  it("names the amount, asset, buyer and window of a lock", () => {
    const tx = buildLockTransaction(new Account(seller, "1"), {
      asset: toAsset("USDC"),
      amount: "25.5",
      buyer,
      windowSeconds: 259_200,
    });
    expect(describeTransaction(tx.toXDR())).toBe(`Lock 25.5 USDC for ${short(buyer)}, claimable by them for 72 hours`);
  });

  it("names a claim and a trustline", () => {
    const balanceId = `00000000${"ab".repeat(32)}`;
    expect(describeTransaction(buildClaimTransaction(new Account(buyer, "1"), balanceId).toXDR())).toBe(
      `Claim the locked balance 00000000abab…abab`,
    );
    expect(describeTransaction(buildUsdcTrustlineTransaction(new Account(buyer, "1")).toXDR())).toBe(
      "Add USDC to your wallet",
    );
  });

  it("falls back to a generic line for XDR it cannot read", () => {
    expect(describeTransaction("not xdr")).toBe("A Stellar testnet transaction");
  });
});
