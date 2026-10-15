import { Account, Asset, Keypair, type Operation } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { TESTNET_USDC_ISSUER } from "./assets";
import {
  CLAIM_WINDOW_SECONDS,
  buildClaimTransaction,
  buildLockTransaction,
  lockBalanceId,
  lockClaimants,
} from "./settlement";

const buyer = Keypair.random().publicKey();
const seller = Keypair.random().publicKey();
const usdc = new Asset("USDC", TESTNET_USDC_ISSUER);

// XDR wire shapes (ClaimPredicateType: 3 = NOT, 5 = BEFORE_RELATIVE_TIME).
const before = (s: number) => ({ type: 5, relBefore: BigInt(s) });
const notBefore = (s: number) => ({ type: 3, notPredicate: before(s) });

describe("lockClaimants", () => {
  it("gives the buyer BEFORE_RELATIVE_TIME(259200) and the seller its NOT", () => {
    const [b, s] = lockClaimants(buyer, seller);
    expect(b.destination).toBe(buyer);
    expect(b.predicate.toXdrObject()).toEqual(before(CLAIM_WINDOW_SECONDS));
    expect(s.destination).toBe(seller);
    expect(s.predicate.toXdrObject()).toEqual(notBefore(CLAIM_WINDOW_SECONDS));
  });

  it("never yields an unconditional claimant", () => {
    for (const c of lockClaimants(buyer, seller, 60)) {
      expect(c.predicate.toXdrObject().type).not.toBe(0);
    }
  });

  it("uses the window it is given (60s for the integration test)", () => {
    const [b, s] = lockClaimants(buyer, seller, 60);
    expect(b.predicate.toXdrObject()).toEqual(before(60));
    expect(s.predicate.toXdrObject()).toEqual(notBefore(60));
  });
});

describe("buildLockTransaction", () => {
  it("is one createClaimableBalance op with exactly two claimants and no third party", () => {
    const tx = buildLockTransaction(new Account(seller, "1"), {
      asset: usdc,
      amount: "25.5",
      buyer,
    });

    expect(tx.source).toBe(seller);
    expect(tx.operations).toHaveLength(1);
    const op = tx.operations[0] as Operation.CreateClaimableBalance;
    expect(op.type).toBe("createClaimableBalance");
    expect(op.amount).toBe("25.5000000");
    expect(op.asset.equals(usdc)).toBe(true);
    expect(op.claimants.map((c) => c.destination)).toEqual([buyer, seller]);
  });

  it("yields a stable balance ID for the built transaction", () => {
    const tx = buildLockTransaction(new Account(seller, "41"), {
      asset: Asset.native(),
      amount: "10",
      buyer,
    });
    const id = lockBalanceId(tx);
    expect(id).toMatch(/^[0-9a-f]{72}$/);
    expect(lockBalanceId(tx)).toBe(id);
  });
});

describe("buildClaimTransaction", () => {
  it("is one claimClaimableBalance op for the given balance", () => {
    const balanceId = lockBalanceId(
      buildLockTransaction(new Account(seller, "7"), {
        asset: Asset.native(),
        amount: "1",
        buyer,
      }),
    );
    const tx = buildClaimTransaction(new Account(buyer, "3"), balanceId);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]).toMatchObject({
      type: "claimClaimableBalance",
      balanceId,
    });
  });
});
