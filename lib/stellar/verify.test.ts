import {
  Account,
  Asset,
  BASE_FEE,
  Claimant,
  Keypair,
  NotFoundError,
  Operation,
  TransactionBuilder,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TESTNET_USDC_ISSUER } from "./assets";
import { horizon } from "./horizon";
import {
  NETWORK_PASSPHRASE,
  buildClaimTransaction,
  buildLockTransaction,
  lockBalanceId,
  lockClaimants,
} from "./settlement";
import { verifyClaimTx, verifyLockTx, type ExpectedLock } from "./verify";

const sellerKey = Keypair.random();
const buyerKey = Keypair.random();
const seller = sellerKey.publicKey();
const buyer = buyerKey.publicKey();
const usdc = new Asset("USDC", TESTNET_USDC_ISSUER);

const expected: ExpectedLock = {
  seller,
  buyer,
  asset: "USDC",
  amount: "25.5000000",
  windowSeconds: 259_200,
};

// What Horizon would return for each hash; a missing hash is a 404.
let ledger: Record<string, { successful: boolean; envelope_xdr: string; created_at: string }>;
// Claimable balances that have already been claimed or reclaimed (gone from the ledger).
let goneBalances: Set<string>;

beforeEach(() => {
  ledger = {};
  goneBalances = new Set();
  vi.spyOn(horizon, "transactions").mockReturnValue({
    transaction: (hash: string) => ({
      call: async () => {
        if (!ledger[hash]) throw new NotFoundError("Not Found", {});
        return ledger[hash];
      },
    }),
  } as never);
  vi.spyOn(horizon, "claimableBalances").mockReturnValue({
    claimableBalance: (id: string) => ({
      call: async () => {
        if (goneBalances.has(id)) throw new NotFoundError("Not Found", {});
        return { id };
      },
    }),
  } as never);
});

afterEach(() => vi.restoreAllMocks());

/** Signs `tx` as the given wallet would and "lands" it on the mock ledger. */
function land(
  tx: Transaction,
  signer: Keypair,
  successful = true,
  createdAt = new Date().toISOString(),
): string {
  tx.sign(signer);
  const hash = Buffer.from(tx.hash()).toString("hex");
  ledger[hash] = { successful, envelope_xdr: tx.toEnvelope().toXDR("base64"), created_at: createdAt };
  return hash;
}

function lockTx(sequence = "1") {
  return buildLockTransaction(new Account(seller, sequence), {
    asset: usdc,
    amount: "25.5",
    buyer,
  });
}

function txWith(source: string, ...ops: xdr.Operation[]) {
  const b = new TransactionBuilder(new Account(source, "1"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  ops.forEach((op) => b.addOperation(op));
  return b.setTimeout(300).build();
}

function lockWithClaimants(claimants: Claimant[]) {
  return Operation.createClaimableBalance({
    asset: usdc,
    amount: "25.5",
    claimants,
  });
}

describe("verifyLockTx", () => {
  it("accepts a real Pairy lock and returns the balance it creates", async () => {
    const tx = lockTx();
    const hash = land(tx, sellerKey);
    await expect(verifyLockTx(hash, expected)).resolves.toEqual({
      balanceId: lockBalanceId(tx),
    });
  });

  it("treats '25.5' on the trade the same as the chain's '25.5000000'", async () => {
    const hash = land(lockTx(), sellerKey);
    await expect(
      verifyLockTx(hash, { ...expected, amount: "25.5" }),
    ).resolves.toHaveProperty("balanceId");
  });

  it("rejects a hash Horizon has never seen", async () => {
    await expect(verifyLockTx("ab".repeat(32), expected)).rejects.toThrow(
      /not found on Stellar testnet/,
    );
  });

  it("rejects a transaction that failed on-chain", async () => {
    const hash = land(lockTx(), sellerKey, false);
    await expect(verifyLockTx(hash, expected)).rejects.toThrow(
      /failed on-chain/,
    );
  });

  it("rejects an extra operation riding along with the lock", async () => {
    const tx = txWith(
      seller,
      lockWithClaimants(lockClaimants(buyer, seller)),
      Operation.payment({ destination: buyer, asset: Asset.native(), amount: "1" }),
    );
    const hash = land(tx, sellerKey);
    await expect(verifyLockTx(hash, expected)).rejects.toThrow(
      /has 2 operations/,
    );
  });

  it("rejects a plain payment", async () => {
    const tx = txWith(
      seller,
      Operation.payment({ destination: buyer, asset: usdc, amount: "25.5" }),
    );
    const hash = land(tx, sellerKey);
    await expect(verifyLockTx(hash, expected)).rejects.toThrow(
      /is a payment, not a createClaimableBalance/,
    );
  });

  it("rejects a lock funded by someone other than the seller", async () => {
    const hash = land(lockTx(), sellerKey);
    const other = Keypair.random().publicKey();
    await expect(
      verifyLockTx(hash, { ...expected, seller: other, buyer }),
    ).rejects.toThrow(/not the trade's seller/);
  });

  it("rejects the wrong asset", async () => {
    const hash = land(lockTx(), sellerKey);
    await expect(
      verifyLockTx(hash, { ...expected, asset: "XLM" }),
    ).rejects.toThrow(/is not in XLM/);
  });

  it("rejects the wrong amount", async () => {
    const hash = land(lockTx(), sellerKey);
    await expect(
      verifyLockTx(hash, { ...expected, amount: "25.4" }),
    ).rejects.toThrow(/holds 25.5000000 USDC, not the agreed 25.4000000/);
  });

  it("rejects a lock naming a different buyer", async () => {
    const stranger = Keypair.random().publicKey();
    const tx = txWith(
      seller,
      lockWithClaimants(lockClaimants(stranger, seller)),
    );
    const hash = land(tx, sellerKey);
    await expect(verifyLockTx(hash, expected)).rejects.toThrow(
      /Claimant 1 .* not the trade's buyer/,
    );
  });

  it("rejects buyer and seller swapped", async () => {
    const tx = txWith(seller, lockWithClaimants(lockClaimants(seller, buyer)));
    const hash = land(tx, sellerKey);
    await expect(verifyLockTx(hash, expected)).rejects.toThrow(
      /not the trade's buyer/,
    );
  });

  it("rejects a third claimant", async () => {
    const tx = txWith(
      seller,
      lockWithClaimants([
        ...lockClaimants(buyer, seller),
        new Claimant(Keypair.random().publicKey()),
      ]),
    );
    const hash = land(tx, sellerKey);
    await expect(verifyLockTx(hash, expected)).rejects.toThrow(
      /has 3 claimants/,
    );
  });

  it("rejects an unconditional buyer claimant", async () => {
    const [, s] = lockClaimants(buyer, seller);
    const tx = txWith(seller, lockWithClaimants([new Claimant(buyer), s]));
    const hash = land(tx, sellerKey);
    await expect(verifyLockTx(hash, expected)).rejects.toThrow(
      /buyer's claim condition .* not the agreed 259200-second window/,
    );
  });

  it("rejects an unconditional seller claimant (instant reclaim)", async () => {
    const [b] = lockClaimants(buyer, seller);
    const tx = txWith(seller, lockWithClaimants([b, new Claimant(seller)]));
    const hash = land(tx, sellerKey);
    await expect(verifyLockTx(hash, expected)).rejects.toThrow(
      /seller's claim condition/,
    );
  });

  it("rejects a lock built with a different window", async () => {
    const tx = txWith(
      seller,
      lockWithClaimants(lockClaimants(buyer, seller, 60)),
    );
    const hash = land(tx, sellerKey);
    await expect(verifyLockTx(hash, expected)).rejects.toThrow(
      /buyer's claim condition/,
    );
  });
});

describe("verifyLockTx against replayed or spent locks", () => {
  it("rejects a lock that landed before the trade existed", async () => {
    // A seller reuses the hash of an old, already-reclaimed lock to the same
    // buyer for the same amount: the shape matches, the timing must not.
    const hash = land(lockTx(), sellerKey, true, "2026-10-01T00:00:00Z");
    await expect(
      verifyLockTx(hash, { ...expected, notBefore: new Date("2026-10-16T00:00:00Z") }),
    ).rejects.toThrow(/before this trade/);
  });

  it("rejects a lock whose balance is no longer on the ledger", async () => {
    const tx = lockTx();
    const hash = land(tx, sellerKey);
    goneBalances.add(lockBalanceId(tx));
    await expect(verifyLockTx(hash, expected)).rejects.toThrow(/no longer/);
  });

  it("still accepts a fresh, live lock that landed after the trade opened", async () => {
    const tx = lockTx();
    const hash = land(tx, sellerKey, true, "2026-10-16T12:00:00Z");
    await expect(
      verifyLockTx(hash, { ...expected, notBefore: new Date("2026-10-16T11:00:00Z") }),
    ).resolves.toEqual({ balanceId: lockBalanceId(tx) });
  });
});

describe("verifyClaimTx", () => {
  const balanceId = lockBalanceId(lockTx("9"));

  it("returns the buyer for a buyer claim", async () => {
    const hash = land(
      buildClaimTransaction(new Account(buyer, "1"), balanceId),
      buyerKey,
    );
    await expect(verifyClaimTx(hash, balanceId)).resolves.toEqual({
      claimant: buyer,
    });
  });

  it("returns the seller for a reclaim", async () => {
    const hash = land(
      buildClaimTransaction(new Account(seller, "2"), balanceId),
      sellerKey,
    );
    await expect(verifyClaimTx(hash, balanceId)).resolves.toEqual({
      claimant: seller,
    });
  });

  it("rejects a claim that failed on-chain", async () => {
    const hash = land(
      buildClaimTransaction(new Account(seller, "3"), balanceId),
      sellerKey,
      false,
    );
    await expect(verifyClaimTx(hash, balanceId)).rejects.toThrow(
      /failed on-chain/,
    );
  });

  it("rejects a claim of some other balance", async () => {
    const other = lockBalanceId(lockTx("10"));
    const hash = land(
      buildClaimTransaction(new Account(buyer, "4"), other),
      buyerKey,
    );
    await expect(verifyClaimTx(hash, balanceId)).rejects.toThrow(
      /not this trade's/,
    );
  });

  it("rejects an extra operation alongside the claim", async () => {
    const tx = txWith(
      buyer,
      Operation.claimClaimableBalance({ balanceId }),
      Operation.payment({ destination: seller, asset: Asset.native(), amount: "1" }),
    );
    const hash = land(tx, buyerKey);
    await expect(verifyClaimTx(hash, balanceId)).rejects.toThrow(
      /has 2 operations/,
    );
  });

  it("rejects a transaction that is not a claim", async () => {
    const hash = land(lockTx("11"), sellerKey);
    await expect(verifyClaimTx(hash, balanceId)).rejects.toThrow(
      /not a claimClaimableBalance/,
    );
  });
});
