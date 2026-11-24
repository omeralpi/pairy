import { readFileSync } from "node:fs";
import path from "node:path";

import { Account, Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { toAsset } from "@/lib/stellar/assets";
import { buildClaimTransaction, buildLockTransaction } from "@/lib/stellar/settlement";
import { buildTrustlineTransaction } from "@/lib/stellar/trustline";

import { describeTransaction } from "./tx-summary";

const seller = Keypair.random().publicKey();
const buyer = Keypair.random().publicKey();
const short = (k: string) => `${k.slice(0, 4)}…${k.slice(-4)}`;
/** A transaction Trustless Work prepared, as recorded under tests/fixtures/tw. */
const twXdr = (name: string): string =>
  JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/tw", `${name}.json`), "utf8")).response.body.unsignedXdr;

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
    expect(describeTransaction(buildTrustlineTransaction(new Account(buyer, "1"), "USDC").toXDR())).toBe(
      "Add USDC to your wallet",
    );
  });

  it("describes an escrow call the way the signing screens do (WP-31)", () => {
    expect(describeTransaction(twXdr("fund"))).toBe("Fund this trade's escrow with 10 USDC");
    expect(describeTransaction(twXdr("gate-d2-fund"))).toBe("Fund this trade's escrow with 5 USDC");
    expect(describeTransaction(twXdr("approve-and-release-milestones"))).toBe(
      "Release this trade's escrow to the buyer, less Trustless Work's 0.3% fee",
    );
    expect(describeTransaction(twXdr("dispute"))).toBe("Open a dispute on this trade's escrow");
    expect(describeTransaction(twXdr("deploy"))).toMatch(/^Create this trade's escrow/);
    expect(describeTransaction(twXdr("fund"))).not.toContain("invokeHostFunction");
  });

  it("falls back to a generic line for XDR it cannot read", () => {
    expect(describeTransaction("not xdr")).toBe("A Stellar testnet transaction");
  });
});
