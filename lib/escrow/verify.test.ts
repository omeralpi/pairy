// verifyEscrowTx and findEscrowTx against Gate D2's deploy, fund and release,
// and the day-12 gate's two real disputes and resolutions, as Horizon recorded
// them (tests/fixtures/horizon/gate-d2.json and wp15-disputes.json: the
// transaction and operation records, FIXES F-02 and X-09). Horizon is faked
// from those records; nothing reaches the network.

import { readFileSync } from "node:fs";
import path from "node:path";

import { Address, Memo, NotFoundError, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { horizon } from "@/lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/settlement";
import { VerifyError } from "@/lib/stellar/verify";

import { ARBITER_ACCOUNT, TW_FACTORY_CONTRACT_ID, TW_FEE_ADDRESS } from "./config";
import { expectedTerms } from "./terms";
import { EscrowMismatchError, findEscrowTx, verifyEscrowTx } from "./verify";

type Recorded = { hash: string; transaction: Record<string, any>; operations: Record<string, any>[] };
const GATE: { steps: Record<"deploy" | "fund" | "release", Recorded>; accounts: Record<string, { account: string; operations: Record<string, any>[] }> } =
  JSON.parse(readFileSync(path.join(process.cwd(), "tests/fixtures/horizon/gate-d2.json"), "utf8"));
type Exit = { contractId: string; accounts: { creation: string; seller: string; buyer: string }; steps: Record<"deploy" | "fund" | "dispute" | "resolve", Recorded> };
/** HD-3's two real-arbiter exits: the buyer disputed and was paid; the seller disputed and was paid back. */
const WP15: { exits: Record<"buyer" | "seller", Exit>; accounts: Record<string, Record<string, any>[]> } = JSON.parse(
  readFileSync(path.join(process.cwd(), "tests/fixtures/horizon/wp15-disputes.json"), "utf8"),
);

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
  const steps = [...Object.values(GATE.steps), ...Object.values(WP15.exits).flatMap((e) => Object.values(e.steps))];
  txs = Object.fromEntries(steps.map((s) => [s.hash, structuredClone(s.transaction)]));
  opsByTx = Object.fromEntries(steps.map((s) => [s.hash, structuredClone(s.operations)]));
  opsByAccount = {
    ...Object.fromEntries(Object.values(GATE.accounts).map((a) => [a.account, structuredClone(a.operations)])),
    ...structuredClone(WP15.accounts),
  };
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
    // The USDC went to a stranger, or came from one (WP-24 judge).
    const STRANGER = "GDPDAXYC6DTRVDM2SBN24JQ4I2EKLSAGMUQ6FSNUYNXKZ566BXGENDYV";
    opsByTx[fund.hash][0].asset_balance_changes = [{ ...transfer, to: STRANGER }];
    await mismatch(verifyEscrowTx(fund.hash, fundOf()));
    opsByTx[fund.hash][0].asset_balance_changes = [{ ...transfer, from: STRANGER }];
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

describe("verifyEscrowTx: the day-12 gate's real disputes and resolutions", () => {
  const { buyer: b, seller: s } = WP15.exits;
  const partiesOf = (e: Exit) => ({ seller: e.accounts.seller, buyer: e.accounts.buyer });
  const disputeOf = (e: Exit, over: Partial<{ contractId: string; parties: { seller: string; buyer: string } }> = {}) =>
    ({ kind: "dispute", contractId: e.contractId, parties: partiesOf(e), ...over }) as const;
  const resolveOf = (e: Exit, over: Partial<{ contractId: string; resolver: string; parties: { seller: string; buyer: string } }> = {}) =>
    ({ kind: "resolve", contractId: e.contractId, resolver: ARBITER_ACCOUNT, parties: partiesOf(e), ...over }) as const;
  const envelopeOf = (r: Recorded): any => xdr.TransactionEnvelope.fromXDR(r.transaction.envelope_xdr, "base64").toXdrObject();
  const maxTimeOf = (r: Recorded) => Number(envelopeOf(r).v1.tx.cond.timeBounds.maxTime);

  /**
   * The buyer's real dispute as another tool might have built it: its own
   * reason, a memo, a 30 XLM fee cap and a day's validity, all of which
   * Pairy's prepare would refuse. `disputer` changes the account it disputes for.
   */
  function foreignDispute(disputer = b.accounts.buyer): string {
    const r = b.steps.dispute;
    const env = envelopeOf(r);
    const tx = env.v1.tx;
    tx.fee = 300_000_000;
    tx.memo = Memo.text("cash never came").toXDRObject().toXdrObject();
    tx.cond.timeBounds.maxTime += 86_400n;
    const args = [Address.fromString(disputer).toScVal(), xdr.ScVal.scvString("The cash never came.")].map((a) => a.toXdrObject());
    const op = tx.operations[0].body.invokeHostFunctionOp;
    op.hostFunction.invokeContract.args = args;
    op.auth[0].rootInvocation.function.contractFn.args = args;
    const envelope = xdr.TransactionEnvelope.fromXdrObject(env).toXDR("base64");
    const hash = Buffer.from(TransactionBuilder.fromXDR(envelope, NETWORK_PASSPHRASE).hash()).toString("hex");
    txs[hash] = { ...structuredClone(r.transaction), hash, envelope_xdr: envelope };
    opsByTx[hash] = structuredClone(r.operations).map((o) => ({ ...o, transaction_hash: hash }));
    return hash;
  }

  it("reads each dispute back with the trader who opened it, at its ledger time", async () => {
    await expect(verifyEscrowTx(b.steps.dispute.hash, disputeOf(b))).resolves.toEqual({
      createdAt: new Date("2026-11-24T09:56:07Z"),
      signer: b.accounts.buyer,
      contractId: b.contractId,
      transfers: [],
    });
    await expect(verifyEscrowTx(s.steps.dispute.hash, disputeOf(s))).resolves.toMatchObject({
      createdAt: new Date("2026-11-24T10:28:02Z"),
      signer: s.accounts.seller,
      contractId: s.contractId,
    });
  });

  it("refuses a dispute on another escrow, by someone who is not one of the two traders, or another call reported as one", async () => {
    await mismatch(verifyEscrowTx(b.steps.dispute.hash, disputeOf(b, { contractId: s.contractId })));
    await mismatch(verifyEscrowTx(b.steps.dispute.hash, disputeOf(b, { parties: partiesOf(s) })));
    await mismatch(verifyEscrowTx(b.steps.fund.hash, disputeOf(b)));
    await mismatch(verifyEscrowTx(b.steps.resolve.hash, disputeOf(b)));
    // Signed by the buyer, disputing for the seller.
    await mismatch(verifyEscrowTx(foreignDispute(b.accounts.seller), disputeOf(b)));
  });

  it("records a dispute built outside Pairy: its reason, memo, fee and validity are not the record's business (D2 §13)", async () => {
    await expect(verifyEscrowTx(foreignDispute(), disputeOf(b))).resolves.toMatchObject({ signer: b.accounts.buyer, contractId: b.contractId });
  });

  it("reads each resolution back with the trader it paid, which is the outcome", async () => {
    await expect(verifyEscrowTx(b.steps.resolve.hash, resolveOf(b))).resolves.toEqual({
      createdAt: new Date("2026-11-24T10:26:57Z"),
      signer: ARBITER_ACCOUNT,
      contractId: b.contractId,
      transfers: [
        { from: b.contractId, to: TW_FEE_ADDRESS, amountStroops: 150_000n },
        { from: b.contractId, to: b.accounts.buyer, amountStroops: 49_850_000n },
      ],
      payout: { to: b.accounts.buyer, amountStroops: 50_000_000n },
    });
    await expect(verifyEscrowTx(s.steps.resolve.hash, resolveOf(s))).resolves.toMatchObject({
      createdAt: new Date("2026-11-24T11:32:52Z"),
      payout: { to: s.accounts.seller, amountStroops: 50_000_000n },
    });
  });

  it("refuses a resolution by another resolver, on another escrow, or paying someone who is not a trader", async () => {
    await mismatch(verifyEscrowTx(b.steps.resolve.hash, resolveOf(b, { resolver: s.accounts.seller })));
    await mismatch(verifyEscrowTx(b.steps.resolve.hash, resolveOf(b, { contractId: s.contractId })));
    await mismatch(verifyEscrowTx(b.steps.resolve.hash, resolveOf(b, { parties: partiesOf(s) })));
    await mismatch(verifyEscrowTx(b.steps.dispute.hash, resolveOf(b)));
  });

  it("accepts a resolution that landed late in its re-timed window, but not after it (O-17)", async () => {
    const r = b.steps.resolve;
    txs[r.hash].created_at = new Date((maxTimeOf(r) - 300) * 1000).toISOString();
    await expect(verifyEscrowTx(r.hash, resolveOf(b))).resolves.toMatchObject({ payout: { to: b.accounts.buyer } });
    txs[r.hash].created_at = new Date((maxTimeOf(r) + 1) * 1000).toISOString();
    await mismatch(verifyEscrowTx(r.hash, resolveOf(b)));
  });
});

describe("findEscrowTx: disputes and resolutions", () => {
  const { buyer: b, seller: s } = WP15.exits;
  const since = new Date("2026-11-24T09:00:00Z");

  it("finds the disputing trader's own dispute and the arbiter's resolution of each escrow", async () => {
    expect(await findEscrowTx(b.accounts.buyer, b.contractId, "dispute_escrow", since)).toBe(b.steps.dispute.hash);
    expect(await findEscrowTx(b.accounts.seller, b.contractId, "dispute_escrow", since)).toBeNull();
    expect(await findEscrowTx(s.accounts.seller, s.contractId, "dispute_escrow", since)).toBe(s.steps.dispute.hash);
    expect(await findEscrowTx(ARBITER_ACCOUNT, b.contractId, "resolve_dispute", since)).toBe(b.steps.resolve.hash);
    expect(await findEscrowTx(ARBITER_ACCOUNT, s.contractId, "resolve_dispute", since)).toBe(s.steps.resolve.hash);
    // The resolution shows in the paid buyer's history too, but the buyer did not make it.
    expect(await findEscrowTx(b.accounts.buyer, b.contractId, "resolve_dispute", since)).toBeNull();
  });
});
