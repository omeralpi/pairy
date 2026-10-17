import {
  Account,
  Asset,
  BASE_FEE,
  Claimant,
  Keypair,
  NotFoundError,
  Operation,
  TransactionBuilder,
  MuxedAccount,
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
  lockClaimants,
} from "./settlement";
import {
  findClaimTx,
  findLockTx,
  lockBalanceId,
  verifyClaimTx,
  verifyLockTx,
  type ExpectedLock,
} from "./verify";

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
// Live claimable balance records, as GET /claimable_balances lists them.
type BalanceRecord = { id: string; asset: string; amount: string; sponsor: string; claimants: { destination: string }[] };
let liveBalances: BalanceRecord[];
// Horizon operation records, newest first, keyed by account or by balance id.
type OpRecord = {
  type: string;
  transaction_successful: boolean;
  transaction_hash: string;
  created_at: string;
  source_account?: string;
  asset?: string;
  amount?: string;
  claimants?: { destination: string }[];
};
// Horizon calls made, to bound the cost of a search (opPages: pages of an account's operations).
let calls: { tx: number; opPages: number };
// When set, every transaction lookup fails like a rate-limited Horizon.
let txError: (() => Error) | null;
let opsByAccount: Record<string, OpRecord[]>;
let opsByBalance: Record<string, OpRecord[]>;

/** A paginated Horizon response over `records`, `size` per page. */
function pageOf(records: OpRecord[], size: number, from = 0, ofAccount = false): unknown {
  if (ofAccount) calls.opPages++;
  return {
    records: records.slice(from, from + size),
    next: async () => pageOf(records, size, from + size, ofAccount),
  };
}

beforeEach(() => {
  ledger = {};
  goneBalances = new Set();
  calls = { tx: 0, opPages: 0 };
  liveBalances = [];
  txError = null;
  vi.spyOn(horizon, "transactions").mockReturnValue({
    transaction: (hash: string) => ({
      call: async () => {
        calls.tx++;
        if (txError) throw txError();
        if (!ledger[hash]) throw new NotFoundError("Not Found", {});
        return ledger[hash];
      },
    }),
  } as never);
  opsByAccount = {};
  opsByBalance = {};
  vi.spyOn(horizon, "operations").mockImplementation(() => {
    let records: OpRecord[] = [];
    let size = 200;
    let ofAccount = false;
    const builder = {
      forAccount: (id: string) => ((records = opsByAccount[id] ?? []), (ofAccount = true), builder),
      forClaimableBalance: (id: string) => ((records = opsByBalance[id] ?? []), builder),
      order: () => builder,
      limit: (n: number) => ((size = n), builder),
      call: async () => pageOf(records, size, 0, ofAccount),
    };
    return builder as never;
  });
  vi.spyOn(horizon, "claimableBalances").mockImplementation(() => {
    const filter: { sponsor?: string; claimant?: string } = {};
    const list = {
      claimableBalance: (id: string) => ({
        call: async () => {
          if (goneBalances.has(id)) throw new NotFoundError("Not Found", {});
          return { id };
        },
      }),
      sponsor: (id: string) => ((filter.sponsor = id), list),
      claimant: (id: string) => ((filter.claimant = id), list),
      limit: () => list,
      call: async () => ({
        records: liveBalances.filter(
          (b) =>
            (!filter.sponsor || b.sponsor === filter.sponsor) &&
            (!filter.claimant || b.claimants.some((c) => c.destination === filter.claimant)),
        ),
      }),
    };
    return list as never;
  });
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
      // The ledger close time, which starts the claim window.
      createdAt: new Date(ledger[hash].created_at),
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
    ).resolves.toMatchObject({ balanceId: lockBalanceId(tx) });
  });
});

/**
 * Records `hash` as one of `account`'s operations on the mock Horizon (newest
 * first). A create_claimable_balance record carries the fields Horizon puts on
 * it, read from the landed transaction's `index`th operation.
 */
function listOp(account: string, type: string, hash: string, successful = true, index = 0) {
  const created_at = ledger[hash]?.created_at ?? new Date().toISOString();
  const record: OpRecord = { type, transaction_successful: successful, transaction_hash: hash, created_at };
  if (type === "create_claimable_balance" && ledger[hash]) {
    const tx = TransactionBuilder.fromXDR(ledger[hash].envelope_xdr, NETWORK_PASSPHRASE) as Transaction;
    const op = tx.operations[index] as Operation.CreateClaimableBalance;
    Object.assign(record, {
      source_account: op.source ?? tx.source,
      asset: op.asset.isNative() ? "native" : `${op.asset.getCode()}:${op.asset.getIssuer()}`,
      amount: op.amount,
      claimants: op.claimants.map((c) => ({ destination: c.destination })),
    });
  }
  (opsByAccount[account] ??= []).unshift(record);
}

describe("findLockTx", () => {
  const notBefore = new Date("2026-10-16T10:00:00Z");
  const withSince = { ...expected, notBefore };

  it("finds this trade's lock among the seller's operations, even after its balance is gone", async () => {
    const tx = lockTx("21");
    const hash = land(tx, sellerKey, true, "2026-10-16T12:00:00Z");
    listOp(seller, "create_claimable_balance", hash);
    goneBalances.add(lockBalanceId(tx));
    await expect(findLockTx(withSince)).resolves.toEqual({
      hash,
      balanceId: lockBalanceId(tx),
      createdAt: new Date("2026-10-16T12:00:00Z"),
    });
  });

  it("ignores a decoy balance to the buyer with other conditions (N-1, S-3)", async () => {
    // Same seller, buyer, asset and amount, but the buyer can never claim it
    // and the seller can take it back at once: not a Pairy lock.
    const decoy = txWith(
      seller,
      lockWithClaimants([
        new Claimant(buyer, Claimant.predicateNot(Claimant.predicateUnconditional())),
        new Claimant(seller, Claimant.predicateUnconditional()),
      ]),
    );
    listOp(seller, "create_claimable_balance", land(decoy, sellerKey, true, "2026-10-16T12:00:00Z"));
    await expect(findLockTx(withSince)).resolves.toBeNull();
  });

  it("skips a lock that already backs another trade, and locks older than the trade", async () => {
    const taken = lockTx("22");
    listOp(seller, "create_claimable_balance", land(taken, sellerKey, true, "2026-10-16T12:00:00Z"));
    listOp(seller, "create_claimable_balance", land(lockTx("23"), sellerKey, true, "2026-10-15T12:00:00Z"));
    await expect(findLockTx(withSince, new Set([lockBalanceId(taken)]))).resolves.toBeNull();
  });

  it("returns the earliest matching lock and reads past the first page", async () => {
    const first = lockTx("24");
    const firstHash = land(first, sellerKey, true, "2026-10-16T11:00:00Z");
    listOp(seller, "create_claimable_balance", firstHash);
    for (let i = 0; i < 250; i++) listOp(seller, "payment", `p${i}`.padEnd(64, "0"));
    vi.mocked(horizon.operations).mockClear();
    await expect(findLockTx(withSince)).resolves.toEqual({
      hash: firstHash,
      balanceId: lockBalanceId(first),
      createdAt: new Date("2026-10-16T11:00:00Z"),
    });
  });
});

describe("findLockTx under load and failure (review findings 2 and 3)", () => {
  const withSince = { ...expected, notBefore: new Date("2026-10-16T10:00:00Z") };

  it("fails instead of answering 'no lock' when Horizon errors", async () => {
    listOp(seller, "create_claimable_balance", land(lockTx("31"), sellerKey, true, "2026-10-16T12:00:00Z"));
    txError = () => Object.assign(new Error("Request failed with status code 429"), { response: { status: 429 } });
    await expect(findLockTx(withSince)).rejects.toThrow(/429/);
  });

  it("does not fetch a stranger's claimable balances that name the seller", async () => {
    const stranger = Keypair.random();
    const spam = Array.from({ length: 100 }, () =>
      Operation.createClaimableBalance({ asset: usdc, amount: "25.5", claimants: [new Claimant(seller)] }),
    );
    const hash = land(txWith(stranger.publicKey(), ...spam), stranger, true, "2026-10-16T12:00:00Z");
    for (let i = 0; i < 100; i++) listOp(seller, "create_claimable_balance", hash, true, i);
    await expect(findLockTx(withSince)).resolves.toBeNull();
    expect(calls.tx).toBe(0);
  });

  it("checks each candidate transaction once", async () => {
    const hash = land(lockTx("32"), sellerKey, true, "2026-10-16T12:00:00Z");
    for (let i = 0; i < 5; i++) listOp(seller, "create_claimable_balance", hash);
    await findLockTx(withSince);
    expect(calls.tx).toBe(1);
  });

  it("falls back to the live balances when the search cannot reach the trade's start (RB2-1)", async () => {
    const tx = lockTx("33");
    const hash = land(tx, sellerKey, true, "2026-10-16T12:00:00Z");
    listOp(seller, "create_claimable_balance", hash);
    for (let i = 0; i < 2000; i++) listOp(seller, "payment", `p${i}`.padEnd(64, "0"));
    const balanceId = lockBalanceId(tx);
    liveBalances.push({
      id: balanceId,
      asset: `USDC:${TESTNET_USDC_ISSUER}`,
      amount: "25.5000000",
      sponsor: seller,
      claimants: [{ destination: buyer }, { destination: seller }],
    });
    opsByBalance[balanceId] = [
      { type: "create_claimable_balance", transaction_successful: true, transaction_hash: hash, created_at: "2026-10-16T12:00:00Z" },
    ];
    await expect(findLockTx(withSince)).resolves.toEqual({ hash, balanceId, createdAt: new Date("2026-10-16T12:00:00Z") });
    // Ten full pages read, and not an eleventh.
    expect(calls.opPages).toBe(10);
  });

  it("answers 'no lock' past the search limit only when no live lock exists either", async () => {
    for (let i = 0; i < 2000; i++) listOp(seller, "payment", `p${i}`.padEnd(64, "0"));
    await expect(findLockTx(withSince)).resolves.toBeNull();
  });

  it("answers 'no lock' for a seller Horizon has no history for, as it does for an unfunded or reset account", async () => {
    // Real Horizon answers /accounts/<id>/operations with a 404 for an account
    // it has never seen, not an empty page.
    vi.mocked(horizon.operations).mockImplementationOnce(() => {
      const builder = {
        forAccount: () => builder,
        order: () => builder,
        limit: () => builder,
        call: async () => {
          throw new NotFoundError("Not Found", {});
        },
      };
      return builder as never;
    });
    await expect(findLockTx(withSince)).resolves.toBeNull();
  });

  it("only looks at locks that landed by notAfter", async () => {
    listOp(seller, "create_claimable_balance", land(lockTx("34"), sellerKey, true, "2026-10-16T12:00:00Z"));
    await expect(findLockTx({ ...withSince, notAfter: new Date("2026-10-16T11:59:00Z") })).resolves.toBeNull();
  });
});

describe("findClaimTx", () => {
  it("returns the successful claim of a balance and ignores failed ones", async () => {
    const id = lockBalanceId(lockTx("31"));
    opsByBalance[id] = [
      { type: "claim_claimable_balance", transaction_successful: false, transaction_hash: "f".repeat(64), created_at: "2026-10-16T12:00:05Z" },
      { type: "claim_claimable_balance", transaction_successful: true, transaction_hash: "c".repeat(64), created_at: "2026-10-16T12:00:00Z" },
      { type: "create_claimable_balance", transaction_successful: true, transaction_hash: "a".repeat(64), created_at: "2026-10-16T11:00:00Z" },
    ];
    await expect(findClaimTx(id)).resolves.toBe("c".repeat(64));
    await expect(findClaimTx(lockBalanceId(lockTx("32")))).resolves.toBeNull();
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
      /does not claim this trade's balance/,
    );
  });

  it("accepts a claim bundled with another operation, as wallets do (S-2)", async () => {
    const tx = txWith(
      buyer,
      Operation.changeTrust({ asset: usdc }),
      Operation.claimClaimableBalance({ balanceId }),
    );
    await expect(verifyClaimTx(land(tx, buyerKey), balanceId)).resolves.toEqual({ claimant: buyer });
  });

  it("reports the base account for a claim from a muxed address (S-2)", async () => {
    const muxed = new MuxedAccount(new Account(buyer, "5"), "42");
    const tx = new TransactionBuilder(muxed, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
      .addOperation(Operation.claimClaimableBalance({ balanceId }))
      .setTimeout(300)
      .build();
    await expect(verifyClaimTx(land(tx, buyerKey), balanceId)).resolves.toEqual({ claimant: buyer });
  });

  it("rejects a transaction that is not a claim", async () => {
    const hash = land(lockTx("11"), sellerKey);
    await expect(verifyClaimTx(hash, balanceId)).rejects.toThrow(
      /does not claim this trade's balance/,
    );
  });
});
