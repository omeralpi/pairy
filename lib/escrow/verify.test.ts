// verifyEscrowTx and findEscrowTx against Gate D2's deploy, fund and release
// as Horizon recorded them (tests/fixtures/horizon/gate-d2.json: the
// transaction and operation records, FIXES F-02 and X-09). Horizon is faked
// from those records; nothing reaches the network.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Address, NotFoundError, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { horizon } from "@/lib/stellar/horizon";
import { VerifyError } from "@/lib/stellar/verify";

import { TW_FACTORY_CONTRACT_ID, TW_FEE_ADDRESS } from "./config";
import { expectedTerms } from "./terms";
import { EscrowMismatchError, findEscrowTx, verifyEscrowTx } from "./verify";

type Recorded = { hash: string; transaction: Record<string, any>; operations: Record<string, any>[] };
const GATE: { steps: Record<"deploy" | "fund" | "release", Recorded>; accounts: Record<string, { account: string; operations: Record<string, any>[] }> } =
  JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/horizon/gate-d2.json"), "utf8"));

const SELLER = "GA7GKEVEKUQIGEF25EOULFCI5MUIWAVXSFAELQZECK5DWLIO27SPAP5Y";
const BUYER = "GB2HNRJNZDLD2FRPS4SKS5Y4HB65IUDI6QSVPID7ZADMLBBQ255TZOYQ";
const ADMIN = "GCITNS4VZSUWYUGFQJHWOMQR4HN3QNS4DCMC5RXBL6NJOTJ7UGAE5BH5";
const ESCROW = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const OTHER_ESCROW = "CCGML7GRKDX42ZYSSXSQYXU7Q5HQ3A6O2SZZPLOYVJY6CROAJHVRYAUN";
const AMOUNT = 50_000_000n;
const terms = expectedTerms({ buyer: BUYER, seller: SELLER, amount: "5", escrowAdmin: ADMIN });
const { deploy, fund, release } = GATE.steps;

const deployOf = (over: Partial<{ admin: string; contractId: string }> = {}) =>
  ({ kind: "deploy", admin: ADMIN, contractId: ESCROW, terms, ...over }) as const;
const fundOf = (over: Partial<{ contractId: string; seller: string; amountStroops: bigint }> = {}) =>
  ({ kind: "fund", contractId: ESCROW, seller: SELLER, amountStroops: AMOUNT, terms, ...over }) as const;
const releaseOf = (over: Partial<{ contractId: string; seller: string }> = {}) =>
  ({ kind: "release", contractId: ESCROW, seller: SELLER, ...over }) as const;

// What the fake Horizon answers: transactions and their operations by hash, operations by account.
let txs: Record<string, Record<string, any>>;
let opsByTx: Record<string, Record<string, any>[]>;
let opsByAccount: Record<string, Record<string, any>[]>;
let horizonDown: boolean;
let accountPages: number;

/** A paginated Horizon answer over `records`, `size` per page. */
function pageOf(records: Record<string, any>[], size: number, from = 0): unknown {
  accountPages++;
  return { records: records.slice(from, from + size), next: async () => pageOf(records, size, from + size) };
}

beforeEach(() => {
  txs = Object.fromEntries(Object.values(GATE.steps).map((s) => [s.hash, structuredClone(s.transaction)]));
  opsByTx = Object.fromEntries(Object.values(GATE.steps).map((s) => [s.hash, structuredClone(s.operations)]));
  opsByAccount = Object.fromEntries(Object.values(GATE.accounts).map((a) => [a.account, structuredClone(a.operations)]));
  horizonDown = false;
  accountPages = 0;
  vi.spyOn(horizon, "transactions").mockReturnValue({
    transaction: (hash: string) => ({
      call: async () => {
        if (horizonDown) throw new Error("Request failed with status code 503");
        if (!txs[hash]) throw new NotFoundError("Not Found", {});
        return txs[hash];
      },
    }),
  } as never);
  vi.spyOn(horizon, "operations").mockImplementation(() => {
    let records: Record<string, any>[] | null = null;
    let size = 10;
    const builder = {
      forTransaction: (hash: string) => ((records = opsByTx[hash] ?? []), builder),
      forAccount: (id: string) => ((records = opsByAccount[id] ?? null), builder),
      order: () => builder,
      limit: (n: number) => ((size = n), builder),
      call: async () => {
        if (horizonDown) throw new Error("Request failed with status code 503");
        if (records === null) throw new NotFoundError("Not Found", {});
        return pageOf(records, size);
      },
    };
    return builder as never;
  });
});

afterEach(() => vi.restoreAllMocks());

const mismatch = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(EscrowMismatchError);
/** A symbol as Horizon puts it in an operation record's parameters. */
const sym = (s: string) => ({ type: "Sym", value: xdr.ScVal.scvSymbol(s).toXDR("base64") });

describe("verifyEscrowTx", () => {
  it("reads Gate D2's deploy back as this trade's escrow creation, signed by its creation key", async () => {
    await expect(verifyEscrowTx(deploy.hash, deployOf())).resolves.toEqual({
      createdAt: new Date("2026-11-24T08:27:57Z"),
      signer: ADMIN,
      contractId: ESCROW,
      transfers: [],
    });
  });

  it("reads the fund back with the USDC it moved from the seller into the escrow", async () => {
    await expect(verifyEscrowTx(fund.hash, fundOf())).resolves.toEqual({
      createdAt: new Date("2026-11-24T08:28:02Z"),
      signer: SELLER,
      contractId: ESCROW,
      transfers: [{ from: SELLER, to: ESCROW, amountStroops: AMOUNT }],
    });
  });

  it("reads the release back with the buyer's net and Trustless Work's fee", async () => {
    const out = await verifyEscrowTx(release.hash, releaseOf());
    expect(out).toMatchObject({ createdAt: new Date("2026-11-24T08:28:07Z"), signer: SELLER, contractId: ESCROW });
    expect(out.transfers).toEqual([
      { from: ESCROW, to: TW_FEE_ADDRESS, amountStroops: 150_000n },
      { from: ESCROW, to: BUYER, amountStroops: 49_850_000n },
    ]);
  });

  it("refuses a deploy that is not this trade's creation", async () => {
    // Another creation key, or not the escrow Pairy stored at prepare (F-02: derived from factory + salt).
    await mismatch(verifyEscrowTx(deploy.hash, deployOf({ admin: SELLER })));
    await mismatch(verifyEscrowTx(deploy.hash, deployOf({ contractId: OTHER_ESCROW })));
    // Roles other than this trade's.
    const swapped = expectedTerms({ buyer: SELLER, seller: BUYER, amount: "5", escrowAdmin: ADMIN });
    await mismatch(verifyEscrowTx(deploy.hash, { ...deployOf(), terms: swapped }));
    await mismatch(verifyEscrowTx(deploy.hash, { ...deployOf(), terms: expectedTerms({ buyer: BUYER, seller: SELLER, amount: "6", escrowAdmin: ADMIN }) }));
  });

  it("refuses a fund that is not this trade's", async () => {
    await mismatch(verifyEscrowTx(fund.hash, fundOf({ amountStroops: AMOUNT + 1n })));
    await mismatch(verifyEscrowTx(fund.hash, fundOf({ amountStroops: AMOUNT - 1n })));
    await mismatch(verifyEscrowTx(fund.hash, fundOf({ contractId: OTHER_ESCROW })));
    await mismatch(verifyEscrowTx(fund.hash, fundOf({ seller: BUYER })));
  });

  it("refuses a release that is not this trade's, and one kind of call reported as another", async () => {
    await mismatch(verifyEscrowTx(release.hash, releaseOf({ seller: BUYER })));
    await mismatch(verifyEscrowTx(release.hash, releaseOf({ contractId: OTHER_ESCROW })));
    await mismatch(verifyEscrowTx(fund.hash, releaseOf()));
    await mismatch(verifyEscrowTx(release.hash, fundOf()));
    await mismatch(verifyEscrowTx(deploy.hash, fundOf()));
  });

  it("refuses when Horizon's operation record names another contract or function than the envelope", async () => {
    opsByTx[fund.hash][0].parameters[1] = sym("approve_and_release_milestones");
    await mismatch(verifyEscrowTx(fund.hash, fundOf()));
    opsByTx[release.hash][0].parameters[0] = { type: "Address", value: Address.fromString(OTHER_ESCROW).toScVal().toXDR("base64") };
    await mismatch(verifyEscrowTx(release.hash, releaseOf()));
  });

  it("refuses when the transaction is not one contract call", async () => {
    opsByTx[fund.hash].push({ ...opsByTx[fund.hash][0], id: "x" });
    await mismatch(verifyEscrowTx(fund.hash, fundOf()));
    opsByTx[release.hash][0].type = "payment";
    await mismatch(verifyEscrowTx(release.hash, releaseOf()));
  });

  it("refuses a fund whose operation record does not show the seller's USDC reaching the escrow", async () => {
    const [transfer] = opsByTx[fund.hash][0].asset_balance_changes;
    opsByTx[fund.hash][0].asset_balance_changes = [{ ...transfer, amount: "4.9999999" }];
    await mismatch(verifyEscrowTx(fund.hash, fundOf()));
    opsByTx[fund.hash][0].asset_balance_changes = [{ ...transfer, asset_issuer: "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO" }];
    await mismatch(verifyEscrowTx(fund.hash, fundOf()));
    opsByTx[fund.hash][0].asset_balance_changes = [];
    await mismatch(verifyEscrowTx(fund.hash, fundOf()));
  });

  it("refuses a transaction that landed after it could have (its envelope's time bounds)", async () => {
    txs[fund.hash].created_at = "2026-11-24T09:28:02Z";
    await mismatch(verifyEscrowTx(fund.hash, fundOf()));
  });

  it("says a missing or failed transaction plainly, and lets a Horizon outage through as an outage", async () => {
    const missing = verifyEscrowTx("f".repeat(64), fundOf());
    await expect(missing).rejects.toThrow(/was not found on Stellar testnet/);
    await expect(missing).rejects.not.toBeInstanceOf(EscrowMismatchError);
    txs[fund.hash].successful = false;
    await expect(verifyEscrowTx(fund.hash, fundOf())).rejects.toThrow(/failed on-chain/);
    horizonDown = true;
    const down = verifyEscrowTx(release.hash, releaseOf()).catch((e: unknown) => e);
    expect(await down).not.toBeInstanceOf(VerifyError);
  });
});

describe("findEscrowTx", () => {
  const since = new Date("2026-11-24T08:00:00Z");

  it("finds the creation account's deploy, and the seller's fund and release, by contract and function", async () => {
    expect(await findEscrowTx(ADMIN, TW_FACTORY_CONTRACT_ID!, "tw_new_single_release_escrow", since)).toBe(deploy.hash);
    expect(await findEscrowTx(SELLER, ESCROW, "fund_escrow", since)).toBe(fund.hash);
    expect(await findEscrowTx(SELLER, ESCROW, "approve_and_release_milestones", since)).toBe(release.hash);
  });

  it("finds nothing for another contract, another function, or before notBefore", async () => {
    expect(await findEscrowTx(SELLER, OTHER_ESCROW, "fund_escrow", since)).toBeNull();
    expect(await findEscrowTx(SELLER, ESCROW, "dispute_escrow", since)).toBeNull();
    expect(await findEscrowTx(ADMIN, TW_FACTORY_CONTRACT_ID!, "tw_new_single_release_escrow", new Date("2026-11-24T08:27:58Z"))).toBeNull();
  });

  it("counts only successful calls the account made itself", async () => {
    opsByAccount[SELLER].find((o) => o.transaction_hash === fund.hash)!.transaction_successful = false;
    expect(await findEscrowTx(SELLER, ESCROW, "fund_escrow", since)).toBeNull();
    // The release shows up in the buyer's history too (it received USDC), but the buyer did not make it.
    opsByAccount[BUYER] = opsByAccount[SELLER].filter((o) => o.transaction_hash === release.hash);
    expect(await findEscrowTx(BUYER, ESCROW, "approve_and_release_milestones", since)).toBeNull();
  });

  it("finds nothing for an account Horizon does not know, and lets an outage through", async () => {
    expect(await findEscrowTx("GDPDAXYC6DTRVDM2SBN24JQ4I2EKLSAGMUQ6FSNUYNXKZ566BXGENDYV", ESCROW, "fund_escrow", since)).toBeNull();
    horizonDown = true;
    await expect(findEscrowTx(SELLER, ESCROW, "fund_escrow", since)).rejects.toThrow(/503/);
  });

  it("reads at most 10 pages of an account's history", async () => {
    const noise = { type: "payment", transaction_successful: true, source_account: SELLER, created_at: "2026-11-24T09:00:00Z" };
    opsByAccount[SELLER] = [...Array.from({ length: 2_000 }, () => noise), ...opsByAccount[SELLER]];
    expect(await findEscrowTx(SELLER, ESCROW, "fund_escrow", since)).toBeNull();
    expect(accountPages).toBe(10);
  });
});
