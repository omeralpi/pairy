import { Account, Asset, Keypair, type Operation } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";

import { TESTNET_USDC_ISSUER } from "./assets";
import {
  CLAIM_WINDOW_SECONDS,
  buildClaimTransaction,
  buildLockTransaction,
  lockClaimants,
} from "./settlement";
import { lockBalanceId } from "./verify";

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

  it("stops at notAfter so a late claim is refused before it can cost a fee (F2)", () => {
    const balanceId = `00000000${"ab".repeat(32)}`;
    const now = Math.floor(Date.now() / 1000);
    const capped = buildClaimTransaction(new Account(buyer, "3"), balanceId, now + 40);
    expect(capped.timeBounds).toEqual({ minTime: "0", maxTime: String(now + 40) });
    // A cutoff hours away is used as is, not shortened to this device's now + 300.
    const far = buildClaimTransaction(new Account(buyer, "3"), balanceId, now + 86_400);
    expect(far.timeBounds!.maxTime).toBe(String(now + 86_400));
    const plain = Number(buildClaimTransaction(new Account(buyer, "3"), balanceId).timeBounds!.maxTime);
    expect(plain - now).toBeGreaterThanOrEqual(300);
    expect(plain - now).toBeLessThanOrEqual(301);
  });

  it("does not depend on the device clock when notAfter is given (round 2 F2)", () => {
    vi.useFakeTimers();
    try {
      const real = 1_800_000_000; // the network's now, unix seconds
      vi.setSystemTime((real - 600) * 1000); // this device runs 10 minutes slow
      const notAfter = real + 3_600; // the claim cutoff, an hour away on the network
      const tx = buildClaimTransaction(new Account(buyer, "3"), `00000000${"ab".repeat(32)}`, notAfter);
      expect(Number(tx.timeBounds!.maxTime)).toBe(notAfter);
      expect(Number(tx.timeBounds!.maxTime)).toBeGreaterThan(real);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fee bid", () => {
  it("bids up to 10,000 stroops on a lock and a claim, so a fee surge cannot shut them out", () => {
    // The network charges what the ledger needs (100 stroops when it is quiet),
    // never more than the bid.
    const seller = new Account(Keypair.random().publicKey(), "1");
    const lock = buildLockTransaction(seller, { asset: Asset.native(), amount: "10", buyer: Keypair.random().publicKey() });
    const claim = buildClaimTransaction(new Account(Keypair.random().publicKey(), "1"), "00000000" + "a".repeat(64));
    expect(lock.fee).toBe("10000");
    expect(claim.fee).toBe("10000");
  });
});
