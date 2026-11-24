// Evidence runs for protected trades (D2 §9): a Trustless Work escrow with
// Pairy's roles on testnet, from creation to one of its exits.
//
//   pnpm tsx scripts/evidence/escrow-exits.ts <release|dispute-buyer|dispute-seller> [--arbiter=test|real] [--dry-run]
//   pnpm tsx scripts/evidence/escrow-exits.ts release --seller=G… [--escrow=C…] [--arbiter=test|real]
//
// release (Gate D2): a fresh creation key deploys the escrow, the seller funds
// it, and the seller alone releases it to the buyer. --arbiter picks the
// dispute resolver the escrow names: the test 2-of-2 from
// scripts/evidence/.state/arbiter-test.json (the default, for repeated runs)
// or ARBITER_ACCOUNT (the evidence run, DECISIONS 14). A release never needs
// the resolver's signature.
//
// dispute-buyer, dispute-seller (WP-15, the day-12 gate): after the fund, that
// side opens a dispute and the arbiter resolves it in that side's favour: the
// whole escrow, less Trustless Work's 0.3%, goes to the side that disputed.
// One resolve is prepared at a time and signed before the next is prepared
// (FIXES F-03); run the two exits one after the other, never at once. Each
// resolve: Trustless Work prepares it; Pairy checks it as returned, checks
// that it uses the arbiter's next sequence number and pays out the escrow's
// USDC balance, re-times only its maxTime to Horizon time +
// RESOLVE_WINDOW_SECONDS, checks that nothing else changed and checks it
// again as the browser would (O-17). The re-timed unsigned resolve and its
// hash go to .state/resolve-<run>.json. Each signer returns a signed copy as
// .state/resolve-<run>.<name>.xdr; the signatures are checked against the
// re-timed hash and merged. Each signature alone is sent first and must be
// refused (tx_bad_auth, no fee), then both are sent. With --arbiter=real,
// Ömer and Ensar sign in Freighter through Stellar Lab and their copies are
// saved by hand (HD-3); with --arbiter=test, this script plays both signers
// with the test 2-of-2's keys through the same files. A window that closes
// first, or a moved arbiter sequence, costs nothing: the resolve is prepared
// again.
//
// --dry-run checks the arbiter account (O-17's preflight) and stops before
// anything is created.
//
// --seller=G… (WP-20, S-06): the seller is an outside wallet, such as a Privy
// wallet in its own browser, whose key this script never holds. It must
// already hold a USDC trustline (Trustless Work refuses the deploy without
// it); if it holds less than the amount, a throwaway account buys the amount
// on the DEX and pays it over. The script deploys the escrow, prepares the
// fund, checks it and stops: the checked, unsigned fund goes to
// .state/handoff-fund.json for the wallet's own browser to check again, sign
// and send (app/(app)/spike-escrow). With --escrow=C…, it prepares that
// escrow's release the same way (.state/handoff-release.json).
//
// Trustless Work only prepares each transaction, through server/tw/client.ts
// with the development key from .env.local (DECISIONS 11). Each one passes
// validateEscrowCall before it is signed (DECISIONS 7), goes straight to
// Horizon as the browser sends it (PLAN I3), and is read back from Horizon by
// hash: the transaction and its operation record, no result meta (FIXES F-02).
// The creation key is makeCreationKey(), the browser's own code (G4): it signs
// the deploy and is dropped. The seller's and buyer's keys live only in this
// process; nothing secret is written.
//
// Appends one run to scripts/evidence/out/escrow-<exit>-<arbiter>.json and
// keeps the earlier ones (FIXES X-05).

import fs from "node:fs";
import path from "node:path";

import {
  Address,
  BASE_FEE,
  Keypair,
  NotFoundError,
  Operation,
  StrKey,
  TransactionBuilder,
  TransactionFailedError,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import dotenv from "dotenv";

import {
  ARBITER_ACCOUNT,
  DISPUTE_REASON,
  MILESTONE_DESCRIPTION,
  PLATFORM_ACCOUNT,
  RESOLVE_WINDOW_SECONDS,
  TW_ESCROW_WASM_HASH,
  TW_FEE_ADDRESS,
  USDC_SAC,
  twViewerUrl,
} from "../../lib/escrow/config";
import { makeCreationKey, type Signer } from "../../lib/escrow/creation-key";
import { netAfterFee, twFee } from "../../lib/escrow/fee";
import type { EscrowTerms } from "../../lib/escrow/terms";
import { mergeSignatures } from "../../lib/escrow/multisig";
import {
  decodeEscrowCall,
  onlyMaxTimeChanged,
  rebuildMaxTime,
  validateEscrowCall,
  type CallExpectation,
} from "../../lib/escrow/xdr";
import { explorerTxUrl, fundWithFriendbot, horizon, networkDeadline } from "../../lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "../../lib/stellar/settlement";
import { TW_ENDPOINTS, twAmount, twCall, type TwInput, type TwOutput } from "../../server/tw/client";
import {
  USDC,
  acquire,
  addUsdcTrustline,
  balanceStroops,
  freshAccount,
  latestLedger,
  loadAccount,
  signAndSubmit,
  toStroops,
  txRecord,
  type Submitted,
} from "../../tests/integration/testnet";
import type { ArbiterTestState } from "../ops/setup-arbiter";
import { readOut, readState, txEvidence, writeOut, writeState } from "./record";
import { readSignedCopy, rentProblem } from "./resolve-checks";

const AMOUNT = "5.0000000";
const soroban = new rpc.Server("https://soroban-testnet.stellar.org");
const STATE_DIR = path.join(__dirname, ".state");
/** Prepares of one resolve before giving up, each valid for RESOLVE_WINDOW_SECONDS. */
const RESOLVE_ATTEMPTS = 3;

type Arbiter = "test" | "real";
type Exit = "release" | "dispute-buyer" | "dispute-seller";
type Transfer = { type: string; from: string; to: string; amountStroops: string };

function check(ok: boolean, problem: string) {
  if (!ok) throw new Error(problem);
}

/** The dispute resolver the escrow names (DECISIONS 14). */
function resolverFor(arbiter: Arbiter): string {
  if (arbiter === "real") return ARBITER_ACCOUNT;
  const test = readState<ArbiterTestState>("arbiter-test");
  if (!test) throw new Error("No test arbiter: run scripts/ops/setup-arbiter.ts --test first.");
  return test.account;
}

/** A trader's wallet, played by a throwaway key that never leaves this process. */
function walletOf(kp: Keypair): Signer {
  return {
    publicKey: kp.publicKey(),
    signTransaction: async (unsignedXdr) => {
      const tx = TransactionBuilder.fromXDR(unsignedXdr, NETWORK_PASSPHRASE);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}

type Sent = { ok: true; hash: string; ledger: number } | { ok: false; hash: string; codes: string[]; resultXdr: string | null };

/** Sends a signed transaction to Horizon, as the browser does. A refusal comes back with its result codes. */
async function trySend(step: string, signedXdr: string): Promise<Sent> {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const hash = Buffer.from(tx.hash()).toString("hex");
  // Printed first: if Horizon times out, look the hash up before running again.
  console.log(`${step}: sending ${hash}`);
  try {
    const res = await horizon.submitTransaction(tx);
    return { ok: true, hash, ledger: res.ledger };
  } catch (e) {
    if (!(e instanceof TransactionFailedError)) throw e;
    const { transaction, operations } = e.getResultCodes();
    return { ok: false, hash, codes: [transaction, ...operations], resultXdr: e.getTransactionResult()?.toXDR("base64") ?? null };
  }
}

async function send(step: string, signedXdr: string): Promise<Submitted> {
  const sent = await trySend(step, signedXdr);
  if (!sent.ok) throw new Error(`${step} ${sent.hash} rejected: ${sent.codes.join(", ")}`);
  return sent;
}

/** Horizon has the transaction: it reached a ledger. */
async function inLedger(hash: string): Promise<boolean> {
  try {
    await txRecord(hash);
    return true;
  } catch (e) {
    if (e instanceof NotFoundError) return false;
    throw e;
  }
}

/**
 * Reads a landed escrow transaction back from Horizon by hash (FIXES F-02,
 * X-09): it is the transaction Pairy checked (Trustless Work's, or for a
 * resolve the re-timed one), it still passes the check at `checkedAt` (by
 * default its ledger's close time), exactly `signers` signed it, and its
 * operation record names the same contract and function. The USDC it moved
 * comes from the operation's asset_balance_changes.
 */
async function readBack(hash: string, preparedHash: string, signers: string[], expectation: CallExpectation, checkedAt?: Date) {
  const rec = await txRecord(hash);
  check(rec.successful, `${hash} failed on chain.`);
  const landed = decodeEscrowCall({ unsignedXdr: rec.envelope_xdr, txHash: hash });
  check(landed.hash === preparedHash, `${hash} is not the transaction Pairy checked (${preparedHash}).`);
  const problems = validateEscrowCall(landed, expectation, checkedAt ?? new Date(rec.created_at));
  check(!problems.length, `${hash} on chain fails the check:\n- ${problems.join("\n- ")}`);

  const signedBy = signers.filter((s) =>
    rec.signatures.some((sig) => Keypair.fromPublicKey(s).verify(Buffer.from(hash, "hex"), Buffer.from(sig, "base64"))),
  );
  check(
    rec.signatures.length === signers.length && signedBy.length === signers.length,
    `${hash} carries ${rec.signatures.length} signatures, by ${signedBy.join(", ") || "none"} of ${signers.join(", ")}; expected exactly those.`,
  );

  const { records } = await horizon.operations().forTransaction(hash).call();
  const op = records[0];
  if (records.length !== 1 || op?.type !== "invoke_host_function") throw new Error(`${hash} is not one contract call.`);
  const [contract, fn] = op.parameters.slice(0, 2).map((p) => scValToNative(xdr.ScVal.fromXDR(p.value, "base64")));
  check(
    contract === landed.contractId && fn === landed.fn,
    `Horizon records ${hash} as ${String(fn)} on ${String(contract)}, not ${landed.fn} on ${landed.contractId}.`,
  );
  const transfers: Transfer[] = (op.asset_balance_changes ?? [])
    .filter((c) => c.asset_code === USDC.code && c.asset_issuer === USDC.issuer)
    .map((c) => ({ type: c.type, from: c.from, to: c.to, amountStroops: String(toStroops(c.amount)) }));
  return { source: rec.source_account, signedBy, contract: String(contract), fn: String(fn), transfers };
}

/** Trustless Work prepares, Pairy checks, the wallet signs, Horizon takes it, Horizon is read back. */
async function step<E extends "deploy" | "fund" | "approveAndRelease" | "dispute">(
  name: string,
  ep: E,
  input: TwInput[E],
  wallet: Signer,
  expect: (prepared: TwOutput[E]) => CallExpectation,
) {
  const at = new Date().toISOString();
  const prepared = await twCall(ep, input, {});
  const expectation = expect(prepared);
  const problems = validateEscrowCall(decodeEscrowCall(prepared), expectation);
  check(!problems.length, `Refusing to sign the ${name}:\n- ${problems.join("\n- ")}`);
  const sub = await send(name, await wallet.signTransaction(prepared.unsignedXdr));
  const back = await readBack(sub.hash, prepared.txHash, [wallet.publicKey], expectation);
  return {
    ...(await txEvidence(name, sub)),
    ...back,
    // Trustless Work's request and answer in the shape of tests/fixtures/tw (gate-d2-*.json come from here).
    tw: {
      endpoint: ep,
      request: { method: TW_ENDPOINTS[ep].method, path: TW_ENDPOINTS[ep].path, apiKeyHeader: true, body: input },
      response: { status: 200, body: prepared },
      at,
    },
  };
}

/**
 * A persistent entry of a contract, read from Soroban RPC as the viewer reads
 * it; null when there is none. Read as of `ledger` or later (the ledger of the
 * step just taken): RPC is a separate service from Horizon, so the answer is
 * used only once the node that gave it has seen that ledger.
 */
async function contractEntry(contractId: string, key: xdr.ScVal, ledger: number) {
  const ledgerKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent,
    }),
  );
  for (let i = 0; i < 30; i++) {
    const res = await soroban.getLedgerEntries(ledgerKey);
    if (res.latestLedger >= ledger) {
      const e = res.entries[0];
      if (!e) return null;
      if (e.val.type !== "contractData") throw new Error(`Soroban RPC answered ${contractId} with a ${e.val.type} entry.`);
      return { value: e.val.contractData.val, liveUntilLedgerSeq: e.liveUntilLedgerSeq ?? null, entryXdr: e.val.toXDR("base64") };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Soroban RPC has not reached ledger ${ledger} after 30 tries.`);
}

/** The escrow contract's USDC: its balance entry in the USDC contract (FIXES X-07). */
async function escrowUsdc(contractId: string, ledger: number): Promise<bigint> {
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), Address.fromString(contractId).toScVal()]);
  const e = await contractEntry(USDC_SAC, key, ledger);
  return e ? (scValToNative(e.value) as { amount: bigint }).amount : 0n;
}

/** The code the escrow runs: the wasm hash in its instance entry. */
async function wasmHashOf(contractId: string, ledger: number): Promise<string | null> {
  const e = await contractEntry(contractId, xdr.ScVal.scvLedgerKeyContractInstance(), ledger);
  if (!e) return null;
  // scValToNative leaves an instance's executable as XDR, so read the hash from the XDR itself.
  const v = e.value;
  if (v.type !== "scvContractInstance" || v.instance.executable.type !== "contractExecutableWasm") return null;
  return Buffer.from(v.instance.executable.wasmHash.value).toString("hex");
}

/** The escrow as the contract stores it: its ["Escrow"] entry (the entry the viewer shows). */
async function escrowOnChain(contractId: string, ledger: number) {
  const e = await contractEntry(contractId, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Escrow")]), ledger);
  if (!e) throw new Error(`Soroban RPC has no ["Escrow"] entry for ${contractId}.`);
  // The contract's struct, decoded: snake_case fields, amounts as bigints.
  const s = scValToNative(e.value) as {
    amount: bigint;
    platform_fee: number;
    released: boolean;
    dispute: { is_disputed: boolean; resolved: boolean };
    trustline: { address: string };
    milestones: { description: string; status: string; approvals?: { approved_by: string[] } }[];
    roles: Record<string, unknown>;
  };
  return {
    roles: s.roles,
    amountStroops: String(s.amount),
    platformFee: s.platform_fee,
    token: s.trustline.address,
    released: s.released,
    disputed: s.dispute.is_disputed,
    resolved: s.dispute.resolved,
    milestones: s.milestones.map((m) => ({ description: m.description, status: m.status, approvedBy: m.approvals?.approved_by ?? [] })),
    liveUntilLedgerSeq: e.liveUntilLedgerSeq,
    // The raw entry, for a decode test (WP-14 read.test.ts).
    entryXdr: e.entryXdr,
  };
}

async function usdcOf(account: string): Promise<bigint> {
  return balanceStroops(await horizon.loadAccount(account), USDC);
}

/** USDC held by everyone in the trade, in stroops. Not the fee address: every Trustless Work escrow pays it. */
async function holdings(label: string, p: { seller: string; buyer: string }, escrow: { contractId: string; ledger: number } | null) {
  const [seller, buyer, platform, escrowHolds] = await Promise.all([
    usdcOf(p.seller),
    usdcOf(p.buyer),
    usdcOf(PLATFORM_ACCOUNT),
    escrow ? escrowUsdc(escrow.contractId, escrow.ledger) : 0n,
  ]);
  return { label, seller, buyer, platform, escrow: escrowHolds };
}

const asStrings = (h: Awaited<ReturnType<typeof holdings>>) => ({
  label: h.label,
  sellerUsdcStroops: String(h.seller),
  buyerUsdcStroops: String(h.buyer),
  platformUsdcStroops: String(h.platform),
  escrowUsdcStroops: String(h.escrow),
});

const sorted = (t: Transfer[]) => JSON.stringify([...t].sort((a, b) => a.to.localeCompare(b.to)));

/**
 * The escrow, deployed by the creation key with Pairy's roles and checked on
 * chain: the instance runs the pinned code, and its ["Escrow"] entry names
 * the roles asked for.
 */
async function deployEscrow(creation: Signer, seller: string, buyer: string, resolver: string, exit: Exit) {
  const amountStroops = toStroops(AMOUNT);
  // Pairy's role mapping (DECISIONS 3, S-16): the seller approves and releases, the buyer receives.
  const terms: EscrowTerms = {
    admin: creation.publicKey,
    platform: PLATFORM_ACCOUNT,
    receiver: buyer,
    approvers: [seller],
    releaseSigners: [seller],
    disputeResolvers: [resolver],
    serviceProviders: [seller],
    otherRoles: [],
    amountStroops,
    platformFeePercent: 0,
    tokenContract: USDC_SAC,
    milestones: [{ description: MILESTONE_DESCRIPTION }],
  };

  const deploy = await step(
    "deploy",
    "deploy",
    {
      signer: creation.publicKey,
      engagementId: `pairy-evidence-${exit}-${Date.now()}`,
      title: "Pairy protected trade",
      description: `Pairy evidence run: ${exit} exit, Stellar testnet`,
      roles: {
        approvers: terms.approvers,
        serviceProviders: terms.serviceProviders,
        releaseSigners: terms.releaseSigners,
        receiver: buyer,
        platform: PLATFORM_ACCOUNT,
        disputeResolvers: [resolver],
        admin: creation.publicKey,
      },
      amount: twAmount(amountStroops),
      platformFee: 0,
      trustline: { contractId: USDC_SAC },
      milestones: [{ description: MILESTONE_DESCRIPTION }],
    },
    creation,
    (p) => ({ kind: "deploy", admin: creation.publicKey, contractId: p.contractId, terms }),
  );
  const contractId = deploy.tw.response.body.contractId;
  console.log(`escrow ${contractId}\n  ${twViewerUrl(contractId)}`);

  // The deployed instance is the escrow Trustless Work named, running the pinned code (FIXES F-02, S-13).
  const wasmHash = await wasmHashOf(contractId, deploy.ledger);
  check(wasmHash === TW_ESCROW_WASM_HASH, `Escrow ${contractId} runs ${wasmHash}, not ${TW_ESCROW_WASM_HASH}.`);
  const created = await escrowOnChain(contractId, deploy.ledger);
  const expectedRoles = {
    admin: creation.publicKey,
    approvers: [seller],
    dispute_resolvers: [resolver],
    platform: PLATFORM_ACCOUNT,
    receiver: buyer,
    release_signers: [seller],
    service_providers: [seller],
  };
  const pairyRoles = Object.fromEntries(Object.keys(expectedRoles).map((k) => [k, created.roles[k]]));
  check(JSON.stringify(pairyRoles) === JSON.stringify(expectedRoles), `The escrow's roles on chain are ${JSON.stringify(created.roles)}.`);
  check(created.amountStroops === String(amountStroops) && !created.released && !created.disputed, "The escrow on chain is not a fresh 5 USDC escrow.");
  return { amountStroops, terms, deploy, contractId, wasmHash, created };
}

/**
 * What every exit starts with: fresh traders, then the escrow, deployed by a
 * fresh creation key, checked on chain and funded by the seller.
 */
async function openEscrow(arbiter: Arbiter, exit: Exit) {
  const resolver = resolverFor(arbiter);

  const creation = makeCreationKey();
  const [sellerKp, buyerKp] = await Promise.all([freshAccount(), freshAccount()]);
  await fundWithFriendbot(creation.publicKey);
  const seller = walletOf(sellerKp);
  const buyer = buyerKp.publicKey();
  const parties = { seller: seller.publicKey, buyer };
  console.log(`seller ${seller.publicKey}\nbuyer ${buyer}\ncreation account ${creation.publicKey}\nresolver ${resolver}`);

  const setup = [
    await txEvidence("seller trustline", await addUsdcTrustline(sellerKp)),
    await txEvidence("buyer trustline", await addUsdcTrustline(buyerKp)),
    await txEvidence(`seller acquires ${AMOUNT} USDC`, await acquire(sellerKp, "USDC", AMOUNT)),
  ];

  const before = await holdings("before deploy", parties, null);
  check(before.seller === toStroops(AMOUNT) && before.buyer === 0n, `The seller holds ${before.seller} and the buyer ${before.buyer} stroops of USDC.`);

  const { amountStroops, terms, deploy, contractId, wasmHash, created } = await deployEscrow(creation, seller.publicKey, buyer, resolver, exit);
  const afterDeploy = await holdings("after deploy", parties, { contractId, ledger: deploy.ledger });

  const fund = await step(
    "fund",
    "fund",
    { contractId, signer: seller.publicKey, amount: twAmount(amountStroops) },
    seller,
    () => ({ kind: "fund", contractId, seller: seller.publicKey, amountStroops, terms }),
  );
  const afterFund = await holdings("after fund", parties, { contractId, ledger: fund.ledger });
  check(
    sorted(fund.transfers) === sorted([{ type: "transfer", from: seller.publicKey, to: contractId, amountStroops: String(amountStroops) }]),
    `The fund moved ${JSON.stringify(fund.transfers)}.`,
  );
  check(afterFund.escrow === amountStroops && afterFund.seller === 0n, "The escrow does not hold the amount after funding.");
  return { resolver, amountStroops, creation, seller, buyerKp, buyer, parties, setup, before, afterDeploy, afterFund, deploy, fund, contractId, wasmHash, created };
}

async function release(arbiter: Arbiter) {
  const startedAt = new Date().toISOString();
  const { resolver, amountStroops, creation, seller, buyer, parties, setup, before, afterDeploy, afterFund, deploy, fund, contractId, wasmHash, created } =
    await openEscrow(arbiter, "release");

  const rel = await step(
    "release",
    "approveAndRelease",
    { contractId, signer: seller.publicKey, milestoneIndexes: [0] },
    seller,
    () => ({ kind: "release", contractId, seller: seller.publicKey }),
  );
  const afterRelease = await holdings("after release", parties, { contractId, ledger: rel.ledger });
  const net = netAfterFee(amountStroops);
  const fee = twFee(amountStroops);
  // The buyer gets 99.7%, Trustless Work's one fee address 0.3%, the platform nothing (fee 0, S-15).
  check(
    sorted(rel.transfers) ===
      sorted([
        { type: "transfer", from: contractId, to: buyer, amountStroops: String(net) },
        { type: "transfer", from: contractId, to: TW_FEE_ADDRESS ?? "", amountStroops: String(fee) },
      ]),
    `The release moved ${JSON.stringify(rel.transfers)}.`,
  );
  check(afterRelease.buyer === net && afterRelease.escrow === 0n, "The buyer does not hold 99.7% or the escrow is not empty.");
  check(afterRelease.platform === before.platform, "The platform account's USDC changed.");
  const released = await escrowOnChain(contractId, rel.ledger);
  check(released.released, "The escrow on chain is not marked released.");

  return {
    at: startedAt,
    network: "testnet",
    asset: "USDC",
    amount: AMOUNT,
    contractId,
    viewerUrl: twViewerUrl(contractId),
    accounts: {
      creation: creation.publicKey,
      seller: seller.publicKey,
      buyer,
      platform: PLATFORM_ACCOUNT,
      resolver,
      trustlessWorkFee: TW_FEE_ADDRESS,
    },
    trustlessWork: { factory: deploy.contract, wasmHash, feeAddress: TW_FEE_ADDRESS },
    escrowAfterDeploy: created,
    escrowAfterRelease: released,
    setup,
    steps: [deploy, fund, rel],
    holdings: [before, afterDeploy, afterFund, afterRelease].map(asStrings),
    result: {
      buyerReceivedStroops: String(afterRelease.buyer - before.buyer),
      buyerSharePercent: Number((afterRelease.buyer - before.buyer) * 10_000n / amountStroops) / 100,
      feeStroops: String(fee),
      feeTo: TW_FEE_ADDRESS,
      platformReceivedStroops: String(afterRelease.platform - before.platform),
      signaturesPerStep: { deploy: deploy.signedBy, fund: fund.signedBy, release: rel.signedBy },
      milestoneStatusStep: false,
    },
  };
}

/**
 * One checked, unsigned call for an outside seller's browser (--seller):
 * app/(app)/spike-escrow rebuilds the expectation from these public facts,
 * checks the transaction again, signs it with the wallet and sends it.
 */
type Handoff = {
  call: "fund" | "release";
  contractId: string;
  viewerUrl: string;
  unsignedXdr: string;
  /** Trustless Work's hash of unsignedXdr: what the wallet signs. */
  txHash: string;
  seller: string;
  amount: string;
  /** The deploy's other parties, for the fund's term check; a release needs none. */
  escrow: { buyer: string; admin: string; resolver: string } | null;
  preparedAt: string;
};

/** Trustless Work prepares, Pairy checks, and the unsigned call is written out for the seller's browser instead of signed here. */
async function prepareHandoff<E extends "fund" | "approveAndRelease">(
  ep: E,
  input: TwInput[E],
  expectation: CallExpectation,
  facts: Omit<Handoff, "unsignedXdr" | "txHash" | "preparedAt">,
) {
  const preparedAt = new Date().toISOString();
  const prepared = await twCall(ep, input, {});
  const problems = validateEscrowCall(decodeEscrowCall(prepared), expectation);
  check(!problems.length, `Refusing to hand over the ${facts.call}:\n- ${problems.join("\n- ")}`);
  const name = `handoff-${facts.call}`;
  writeState(name, { ...facts, unsignedXdr: prepared.unsignedXdr, txHash: prepared.txHash, preparedAt } satisfies Handoff);
  console.log(
    [
      `${facts.call} of escrow ${facts.contractId} prepared for ${facts.seller} at ${preparedAt}, checked, unsigned (valid about 5 minutes):`,
      prepared.unsignedXdr,
      `hash ${prepared.txHash}`,
      `Handed over in scripts/evidence/.state/${name}.json; the seller's browser signs and sends it.`,
    ].join("\n"),
  );
}

/** A throwaway buys the amount on the DEX and pays it to the seller: the seller's own key signs nothing here. */
async function payUsdcTo(seller: string) {
  const helper = await freshAccount();
  await addUsdcTrustline(helper);
  await acquire(helper, "USDC", AMOUNT);
  const tx = new TransactionBuilder(await loadAccount(helper), { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.payment({ destination: seller, asset: USDC, amount: AMOUNT }))
    .setTimeout(300)
    .build();
  return signAndSubmit(tx, helper);
}

/**
 * --seller: the escrow for an outside seller up to its unsigned fund, or that
 * escrow's unsigned release (--escrow). Everything the seller signs happens in
 * its own browser; this process holds the creation key and the buyer's only.
 */
async function handoffRun(arbiter: Arbiter, seller: string, escrow: string | null) {
  if (escrow) {
    await prepareHandoff(
      "approveAndRelease",
      { contractId: escrow, signer: seller, milestoneIndexes: [0] },
      { kind: "release", contractId: escrow, seller },
      { call: "release", contractId: escrow, viewerUrl: twViewerUrl(escrow), seller, amount: AMOUNT, escrow: null },
    );
    return;
  }
  const resolver = resolverFor(arbiter);
  const amountStroops = toStroops(AMOUNT);
  const account = await horizon.loadAccount(seller);
  check(
    account.balances.some((b) => "asset_code" in b && b.asset_code === USDC.code && b.asset_issuer === USDC.issuer),
    `The seller ${seller} holds no USDC trustline; add it from the wallet page first (Trustless Work refuses the deploy without it).`,
  );
  const creation = makeCreationKey();
  const buyerKp = await freshAccount();
  await fundWithFriendbot(creation.publicKey);
  const buyer = buyerKp.publicKey();
  console.log(`seller ${seller} (outside wallet)\nbuyer ${buyer}\ncreation account ${creation.publicKey}\nresolver ${resolver}`);
  await addUsdcTrustline(buyerKp);
  if ((await usdcOf(seller)) < amountStroops) {
    const paid = await payUsdcTo(seller);
    console.log(`a throwaway paid the seller ${AMOUNT} USDC: ${paid.hash}`);
  }
  const held = await usdcOf(seller);
  check(held >= amountStroops, `The seller holds ${held} stroops of USDC, less than ${amountStroops}.`);

  const { terms, contractId } = await deployEscrow(creation, seller, buyer, resolver, "release");
  await prepareHandoff(
    "fund",
    { contractId, signer: seller, amount: twAmount(amountStroops) },
    { kind: "fund", contractId, seller, amountStroops, terms },
    { call: "fund", contractId, viewerUrl: twViewerUrl(contractId), seller, amount: AMOUNT, escrow: { buyer, admin: creation.publicKey, resolver } },
  );
}

/**
 * The arbiter account as Horizon shows it now, after O-17's preflight: its own
 * key at weight 0, every threshold at least 2, no signer able to meet a
 * threshold alone, and at least two signers. Horizon lists the account's own
 * key among its signers (at weight 0), so it is left out of `signers`.
 */
async function arbiterNow(account: string) {
  const acc = await horizon.loadAccount(account);
  const { low_threshold: low, med_threshold: med, high_threshold: high } = acc.thresholds;
  const own = acc.signers.find((s) => s.key === account)?.weight ?? 0;
  const signers = acc.signers.filter((s) => s.key !== account && s.weight >= 1);
  const lowest = Math.min(low, med, high);
  const problems = [
    own !== 0 ? `its own key has weight ${own}` : "",
    lowest < 2 ? `its thresholds are ${low}/${med}/${high}` : "",
    signers.some((s) => s.weight >= lowest) ? "one signer alone meets a threshold" : "",
    signers.length < 2 ? `it has ${signers.length} signers` : "",
  ].filter(Boolean);
  check(!problems.length, `The arbiter account ${account} fails the preflight (O-17): ${problems.join("; ")}.`);
  return {
    account,
    sequence: acc.sequence,
    thresholds: { low, med, high },
    signers: signers.map((s) => s.key),
    weights: Object.fromEntries(signers.map((s) => [s.key, s.weight])) as Record<string, number>,
  };
}

/** The test 2-of-2's signer keys, which this script uses to play both signers. They must be the account's signers on Horizon. */
function testSignerKeys(arbiter: Awaited<ReturnType<typeof arbiterNow>>): Keypair[] {
  const keys = readState<ArbiterTestState>("arbiter-test")!.signers.map((s) => Keypair.fromSecret(s.secret));
  const pub = keys.map((k) => k.publicKey());
  check(
    JSON.stringify([...pub].sort()) === JSON.stringify([...arbiter.signers].sort()),
    `The keys in .state/arbiter-test.json are not the signers of ${arbiter.account} on Horizon.`,
  );
  return keys;
}

/** What a refused resolve means (S-19). None of these reaches a ledger, so nothing is charged. */
function explain(codes: string[]): string {
  if (codes[0] === "tx_bad_auth") return "tx_bad_auth: not enough signatures; the arbiter needs both signers (thresholds 2, each signer weight 1)";
  if (codes[0] === "tx_bad_seq") return "tx_bad_seq: the arbiter account's sequence moved after this resolve was prepared; prepare it again";
  if (codes[0] === "tx_too_late") return "tx_too_late: this resolve's time window closed; prepare it again";
  return codes.join(", ");
}

/**
 * Steps 1-6 of a resolve (FIXES F-03, O-17): Trustless Work prepares it, Pairy
 * checks it as returned, checks the arbiter's sequence and the escrow's USDC
 * balance, re-times its maxTime only, checks nothing else changed, and checks
 * the re-timed resolve as the browser does before anyone signs.
 */
async function prepareResolve(contractId: string, resolver: string, recipient: string, ledger: number) {
  const arbiter = await arbiterNow(resolver);
  const escrow = await escrowOnChain(contractId, ledger);
  check(escrow.disputed && !escrow.resolved && !escrow.released, `Escrow ${contractId} is not in an open dispute.`);
  const latest = (await latestLedger()).sequence;
  const rent = rentProblem(escrow.liveUntilLedgerSeq, latest);
  if (rent) throw new Error(rent);
  // The contract pays out its USDC SAC balance, never the stored amount (FIXES F-03, X-07).
  const balance = await escrowUsdc(contractId, ledger);
  const expectation = { kind: "resolve", contractId, resolver, recipient, amountStroops: balance } as const;

  const at = new Date().toISOString();
  const input: TwInput["resolve"] = { contractId, disputeResolver: resolver, distributions: [{ address: recipient, amount: twAmount(balance) }] };
  const prepared = await twCall("resolve", input, {});
  const tw = decodeEscrowCall(prepared);
  let problems = validateEscrowCall(tw, { ...expectation, timePolicy: "server-original" });
  check(!problems.length, `Refusing Trustless Work's resolve:\n- ${problems.join("\n- ")}`);
  const sequence = (TransactionBuilder.fromXDR(prepared.unsignedXdr, NETWORK_PASSPHRASE) as Transaction).sequence;
  check(BigInt(sequence) === BigInt(arbiter.sequence) + 1n, `The resolve uses sequence ${sequence}, not the arbiter's next after ${arbiter.sequence}.`);

  const maxTime = await networkDeadline(RESOLVE_WINDOW_SECONDS);
  const rebuilt = rebuildMaxTime(prepared.unsignedXdr, maxTime);
  check(onlyMaxTimeChanged(prepared.unsignedXdr, rebuilt.unsignedXdr), "The re-timed resolve differs from Trustless Work's in more than its maxTime.");
  problems = validateEscrowCall(decodeEscrowCall(rebuilt), { ...expectation, timePolicy: "browser-rebuilt" });
  check(!problems.length, `Refusing the re-timed resolve:\n- ${problems.join("\n- ")}`);
  console.log(`resolve prepared: sequence ${sequence}, Trustless Work's hash ${prepared.txHash}, re-timed ${rebuilt.txHash}`);

  return {
    expectation,
    arbiter,
    sequence,
    sacBalanceStroops: String(balance),
    escrowTtl: { liveUntilLedgerSeq: escrow.liveUntilLedgerSeq, latestLedger: latest },
    tw: {
      endpoint: "resolve" as const,
      request: { method: TW_ENDPOINTS.resolve.method, path: TW_ENDPOINTS.resolve.path, apiKeyHeader: true, body: input },
      response: { status: 200, body: prepared },
      at,
    },
    twTimeBounds: tw.timeBounds,
    authCredentials: tw.authRoots.map((a) => a.credentials),
    rebuilt: {
      horizonTime: maxTime - RESOLVE_WINDOW_SECONDS,
      maxTime,
      validUntil: new Date(maxTime * 1000).toISOString(),
      unsignedXdr: rebuilt.unsignedXdr,
      txHash: rebuilt.txHash,
    },
  };
}
type Prepared = Awaited<ReturnType<typeof prepareResolve>>;

/**
 * Step 7: the signatures, through files in .state/. The re-timed unsigned
 * resolve and its hash go to resolve-<run>.json; each signer's signed copy is
 * read from resolve-<run>.<name>.xdr. With `testKeys` this script writes those
 * copies itself, one per signer, each signed apart. Each signature is checked
 * against the re-timed hash (O-17), and exactly the threshold's worth is kept,
 * because an extra one is refused (tx_bad_auth_extra). Null when the window
 * closes first.
 */
async function collectSignatures(run: string, prep: Prepared, testKeys: Keypair[] | null) {
  const { arbiter, rebuilt } = prep;
  const name = `resolve-${run}`;
  writeState(name, {
    contractId: prep.expectation.contractId,
    resolver: arbiter.account,
    signers: arbiter.signers,
    recipient: prep.expectation.recipient,
    amountStroops: prep.sacBalanceStroops,
    unsignedXdr: rebuilt.unsignedXdr,
    txHash: rebuilt.txHash,
    validUntil: rebuilt.validUntil,
  });
  console.log(
    [
      `Unsigned resolve in scripts/evidence/.state/${name}.json, valid until ${rebuilt.validUntil}:`,
      rebuilt.unsignedXdr,
      `hash ${rebuilt.txHash}`,
      `Waiting for each signer's signed copy as scripts/evidence/.state/${name}.<name>.xdr`,
    ].join("\n"),
  );
  for (const kp of testKeys ?? []) {
    const tx = TransactionBuilder.fromXDR(rebuilt.unsignedXdr, NETWORK_PASSPHRASE);
    tx.sign(kp);
    fs.writeFileSync(path.join(STATE_DIR, `${name}.${kp.publicKey()}.xdr`), `${tx.toXDR()}\n`, { mode: 0o600 });
  }

  const need = Math.max(arbiter.thresholds.low, arbiter.thresholds.med);
  const found = new Map<string, { signature: string; receivedAt: string }>();
  const ignored = new Set<string>();
  for (let poll = 0; ; poll++) {
    for (const f of fs.readdirSync(STATE_DIR).filter((f) => f.startsWith(`${name}.`) && f.endsWith(".xdr")).sort()) {
      const text = fs.readFileSync(path.join(STATE_DIR, f), "utf8").trim();
      if (!text || ignored.has(`${f}\n${text}`)) continue;
      const copy = readSignedCopy(text, rebuilt.txHash, arbiter.signers);
      if (copy.problem) {
        ignored.add(`${f}\n${text}`);
        console.log(`${f}: ${copy.problem}`);
        continue;
      }
      for (const s of copy.signatures) {
        if (found.has(s.signer)) continue;
        found.set(s.signer, { signature: s.signature, receivedAt: new Date().toISOString() });
        console.log(`${f}: a signature by ${s.signer}`);
      }
    }
    const chosen: { signer: string; signature: string; receivedAt: string }[] = [];
    let weight = 0;
    for (const [signer, s] of found) {
      if (weight >= need) break;
      chosen.push({ signer, ...s });
      weight += arbiter.weights[signer];
    }
    if (weight >= need) return chosen;
    if (Date.now() / 1000 > rebuilt.maxTime - 60) return null;
    if (poll % 60 === 59) console.log(`still waiting: ${found.size} of ${arbiter.signers.length} signers so far, valid until ${rebuilt.validUntil}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

/**
 * The resolve, steps 1-9: prepared and signed one at a time (FIXES F-03). Just
 * before sending, the arbiter's sequence is checked again; then each signature
 * alone is sent and must be refused, and then both. A closed window or a moved
 * sequence costs nothing, so the resolve is prepared again, up to
 * RESOLVE_ATTEMPTS times. Each attempt is pushed to `attempts`, which the
 * caller keeps for the run record even when this throws.
 */
async function resolveDispute(
  run: string,
  contractId: string,
  resolver: string,
  recipient: string,
  ledger: number,
  testKeys: Keypair[] | null,
  attempts: unknown[],
) {
  for (let attempt = 1; attempt <= RESOLVE_ATTEMPTS; attempt++) {
    const prep = await prepareResolve(contractId, resolver, recipient, ledger);
    const summary = {
      attempt,
      preparedAt: prep.tw.at,
      sequence: prep.sequence,
      twTxHash: prep.tw.response.body.txHash,
      twTimeBounds: prep.twTimeBounds,
      rebuiltTxHash: prep.rebuilt.txHash,
      validUntil: prep.rebuilt.validUntil,
    };
    const sigs = await collectSignatures(`${run}-${attempt}`, prep, testKeys);
    if (!sigs) {
      console.log(`attempt ${attempt}: the window closed before the signatures arrived; preparing again`);
      attempts.push({ ...summary, outcome: "the window closed before the signatures arrived" });
      continue;
    }
    const merged = mergeSignatures(prep.rebuilt.unsignedXdr, sigs);
    const now = await arbiterNow(resolver);
    if (now.sequence !== prep.arbiter.sequence) {
      console.log(`attempt ${attempt}: the arbiter's sequence moved to ${now.sequence}; preparing again`);
      attempts.push({ ...summary, outcome: `the arbiter's sequence moved to ${now.sequence} before sending` });
      continue;
    }

    // Each signer alone (S-19): refused before any ledger, so no fee and no sequence moves.
    const singleSignatures = [];
    for (const sig of sigs) {
      const alone = mergeSignatures(prep.rebuilt.unsignedXdr, [sig]);
      const single = await trySend(`resolve signed by ${sig.signer} alone`, alone);
      check(!single.ok, `A resolve with one signature landed: ${single.hash}.`);
      const refused = {
        envelopeXdr: alone,
        hash: single.hash,
        signer: sig.signer,
        codes: single.ok ? [] : single.codes,
        resultXdr: single.ok ? null : single.resultXdr,
        explained: single.ok ? "" : explain(single.codes),
        inLedger: await inLedger(single.hash),
        arbiterSequenceAfter: (await arbiterNow(resolver)).sequence,
      };
      console.log(`one signature: ${refused.explained}`);
      check(
        refused.codes[0] === "tx_bad_auth" && !refused.inLedger && refused.arbiterSequenceAfter === prep.arbiter.sequence,
        `The one-signature resolve was not refused as expected: ${JSON.stringify(refused)}`,
      );
      singleSignatures.push(refused);
    }

    let sent: Sent;
    try {
      sent = await trySend("resolve", merged);
    } catch (e) {
      // N6: both signatures are on an envelope Horizon may still include, so nobody signs again.
      const why = `Horizon gave no clear answer to the resolve (${e instanceof Error ? e.message : String(e)})`;
      attempts.push({ ...summary, singleSignatures, outcome: why });
      console.error(
        `${why}. It may still land: look up hash ${prep.rebuilt.txHash} before anything else. ` +
          `The signed copies are in scripts/evidence/.state/resolve-${run}-${attempt}.*.xdr. Do not sign again; tell the orchestrator this hash.`,
      );
      throw e;
    }
    if (!sent.ok) {
      const why = explain(sent.codes);
      check(sent.codes[0] === "tx_too_late" || sent.codes[0] === "tx_bad_seq", `The resolve ${sent.hash} was refused: ${why}`);
      console.log(`attempt ${attempt}: ${why}`);
      attempts.push({ ...summary, singleSignatures, outcome: why });
      continue;
    }
    attempts.push({ ...summary, outcome: "landed" });
    const back = await readBack(
      sent.hash,
      prep.rebuilt.txHash,
      sigs.map((s) => s.signer),
      { ...prep.expectation, timePolicy: "browser-rebuilt" },
      new Date(prep.rebuilt.horizonTime * 1000),
    );
    return {
      ...(await txEvidence("resolve", sent)),
      ...back,
      tw: prep.tw,
      // With `tw`, the shape of tests/fixtures/tw/exits-test-resolve-*.json.
      resolve: {
        escrowTtl: prep.escrowTtl,
        arbiter: { account: prep.arbiter.account, signers: prep.arbiter.signers, thresholds: prep.arbiter.thresholds, sequence: prep.arbiter.sequence },
        sacBalanceStroops: prep.sacBalanceStroops,
        twTimeBounds: prep.twTimeBounds,
        authCredentials: prep.authCredentials,
        rebuilt: prep.rebuilt,
        signatures: sigs,
        singleSignatures,
        landed: { signedXdr: merged, hash: sent.hash, ledger: sent.ledger, url: explorerTxUrl(sent.hash) },
      },
      attempts,
    };
  }
  throw new Error(`No resolve landed after ${RESOLVE_ATTEMPTS} prepares; escrow ${contractId} is still in dispute.`);
}

/** What a dispute run has done so far: main() records it if the run throws (N2, FIXES X-05). */
type Progress = { at?: string; contractId?: string; viewerUrl?: string; accounts?: Record<string, unknown>; steps: unknown[]; resolveAttempts: unknown[] };

/** dispute-buyer / dispute-seller: that side disputes, and the arbiter pays that side the whole escrow less the fee. */
async function disputeExit(side: "buyer" | "seller", arbiter: Arbiter, progress: Progress) {
  const startedAt = new Date().toISOString();
  const exit: Exit = `dispute-${side}`;
  const run = `${exit}-${arbiter}-${startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
  const arbiterAtStart = await arbiterNow(resolverFor(arbiter));
  const testKeys = arbiter === "test" ? testSignerKeys(arbiterAtStart) : null;
  const o = await openEscrow(arbiter, exit);
  const { contractId, amountStroops, parties, seller, buyer, before } = o;
  const accounts = {
    creation: o.creation.publicKey,
    seller: seller.publicKey,
    buyer,
    platform: PLATFORM_ACCOUNT,
    resolver: o.resolver,
    arbiterSigners: arbiterAtStart.signers,
    trustlessWorkFee: TW_FEE_ADDRESS,
  };
  Object.assign(progress, { at: startedAt, contractId, viewerUrl: twViewerUrl(contractId), accounts, steps: [o.deploy, o.fund] });

  const disputer = side === "buyer" ? walletOf(o.buyerKp) : seller;
  const dispute = await step(
    "dispute",
    "dispute",
    { contractId, signer: disputer.publicKey, reason: DISPUTE_REASON },
    disputer,
    () => ({ kind: "dispute", contractId, signer: disputer.publicKey }),
  );
  progress.steps.push(dispute);
  check(dispute.transfers.length === 0, `The dispute moved ${JSON.stringify(dispute.transfers)}.`);
  const disputed = await escrowOnChain(contractId, dispute.ledger);
  check(disputed.disputed && !disputed.resolved && !disputed.released, "The escrow on chain is not in dispute.");
  const afterDispute = await holdings("after dispute", parties, { contractId, ledger: dispute.ledger });
  check(afterDispute.escrow === amountStroops, "The escrow does not hold the amount after the dispute.");

  const recipient = disputer.publicKey;
  const res = await resolveDispute(run, contractId, o.resolver, recipient, dispute.ledger, testKeys, progress.resolveAttempts);
  const afterResolve = await holdings("after resolve", parties, { contractId, ledger: res.ledger });
  const net = netAfterFee(amountStroops);
  const fee = twFee(amountStroops);
  // The side that disputed gets 99.7%, Trustless Work's one fee address 0.3%, the platform nothing.
  check(
    sorted(res.transfers) ===
      sorted([
        { type: "transfer", from: contractId, to: recipient, amountStroops: String(net) },
        { type: "transfer", from: contractId, to: TW_FEE_ADDRESS ?? "", amountStroops: String(fee) },
      ]),
    `The resolve moved ${JSON.stringify(res.transfers)}.`,
  );
  const got = (h: typeof afterResolve) => (side === "buyer" ? h.buyer : h.seller);
  check(got(afterResolve) - got(afterDispute) === net && afterResolve.escrow === 0n, `The ${side} did not receive 99.7% or the escrow is not empty.`);
  check(afterResolve.platform === before.platform, "The platform account's USDC changed.");
  const resolved = await escrowOnChain(contractId, res.ledger);
  check(resolved.resolved, "The escrow on chain is not marked resolved.");

  return {
    at: startedAt,
    network: "testnet",
    asset: "USDC",
    amount: AMOUNT,
    exit,
    contractId,
    viewerUrl: twViewerUrl(contractId),
    accounts,
    trustlessWork: { factory: o.deploy.contract, wasmHash: o.wasmHash, feeAddress: TW_FEE_ADDRESS },
    escrowAfterDeploy: o.created,
    escrowAfterDispute: disputed,
    escrowAfterResolve: resolved,
    setup: o.setup,
    steps: [o.deploy, o.fund, dispute, { ...res, resolve: { escrow: { contractId, seller: seller.publicKey, buyer, disputer: side, recipient }, ...res.resolve } }],
    holdings: [before, o.afterDeploy, o.afterFund, afterDispute, afterResolve].map(asStrings),
    result: {
      disputedBy: side,
      paidTo: side,
      recipient,
      recipientReceivedStroops: String(got(afterResolve) - got(afterDispute)),
      recipientSharePercent: Number(((got(afterResolve) - got(afterDispute)) * 10_000n) / amountStroops) / 100,
      feeStroops: String(fee),
      feeTo: TW_FEE_ADDRESS,
      platformReceivedStroops: String(afterResolve.platform - before.platform),
      signaturesPerStep: { deploy: o.deploy.signedBy, fund: o.fund.signedBy, dispute: dispute.signedBy, resolve: res.signedBy },
      oneSignatureRefused: res.resolve.singleSignatures.map((s) => `${s.signer} alone: ${s.codes.join(", ")}`),
      resolveWindowSeconds: RESOLVE_WINDOW_SECONDS,
      resolvePrepares: res.attempts.length,
    },
  };
}

type Out = { exit: Exit; arbiter: Arbiter; runs: unknown[] };

/** Appends one run to scripts/evidence/out/escrow-<exit>-<arbiter>.json and keeps the earlier ones (FIXES X-05). */
function appendRun(exit: Exit, arbiter: Arbiter, run: unknown) {
  const name = `escrow-${exit}-${arbiter}`;
  writeOut(name, { exit, arbiter, runs: [...(readOut<Out>(name)?.runs ?? []), run] } satisfies Out);
}

async function main() {
  dotenv.config({ path: path.join(__dirname, "../../.env.local"), quiet: true });
  const [exit, ...flags] = process.argv.slice(2);
  const arbiter = flags.find((f) => f.startsWith("--arbiter="))?.replace(/^--arbiter=/, "") ?? "test";
  const dryRun = flags.includes("--dry-run");
  const seller = flags.find((f) => f.startsWith("--seller="))?.replace(/^--seller=/, "") ?? null;
  const escrow = flags.find((f) => f.startsWith("--escrow="))?.replace(/^--escrow=/, "") ?? null;
  if (
    (exit !== "release" && exit !== "dispute-buyer" && exit !== "dispute-seller") ||
    flags.some((f) => f !== "--dry-run" && !/^--(arbiter|seller|escrow)=/.test(f)) ||
    (arbiter !== "test" && arbiter !== "real") ||
    (seller !== null && (exit !== "release" || dryRun || !StrKey.isValidEd25519PublicKey(seller))) ||
    (escrow !== null && (seller === null || !StrKey.isValidContract(escrow)))
  ) {
    throw new Error(
      "Usage: escrow-exits.ts <release|dispute-buyer|dispute-seller> [--arbiter=test|real] [--dry-run]\n" +
        "       escrow-exits.ts release --seller=G… [--escrow=C…] [--arbiter=test|real]",
    );
  }
  if (seller) {
    await handoffRun(arbiter, seller, escrow);
    return;
  }
  if (dryRun) {
    const a = await arbiterNow(resolverFor(arbiter));
    if (arbiter === "test") testSignerKeys(a);
    console.log(
      [
        `arbiter ${a.account} passes the preflight (O-17): thresholds ${a.thresholds.low}/${a.thresholds.med}/${a.thresholds.high}, sequence ${a.sequence}`,
        ...a.signers.map((s) => `signer ${s} weight ${a.weights[s]}`),
        `A ${exit} run makes a ${AMOUNT} USDC escrow naming this arbiter${exit === "release" ? "." : `, has the ${exit.slice(8)} dispute it, and prepares one resolve valid for ${RESOLVE_WINDOW_SECONDS / 60} minutes.`}`,
        "Dry run: nothing was created.",
      ].join("\n"),
    );
    return;
  }
  if (exit === "release") {
    const run = await release(arbiter);
    appendRun(exit, arbiter, run);
    console.log(
      `buyer received ${run.result.buyerReceivedStroops} stroops (${run.result.buyerSharePercent}%), fee ${run.result.feeStroops} to ${run.result.feeTo}`,
    );
    return;
  }
  const progress: Progress = { steps: [], resolveAttempts: [] };
  const run = await disputeExit(exit === "dispute-buyer" ? "buyer" : "seller", arbiter, progress).catch((e: unknown) => {
    // N2: once the escrow exists, a run that stops keeps its escrow id, its steps and its resolve attempts.
    if (progress.contractId) {
      appendRun(exit, arbiter, { ...progress, network: "testnet", asset: "USDC", amount: AMOUNT, exit, partial: true, error: e instanceof Error ? e.message : String(e) });
      console.error(`The run stopped after escrow ${progress.contractId} was funded; its partial record is in scripts/evidence/out/escrow-${exit}-${arbiter}.json.`);
    }
    throw e;
  });
  appendRun(exit, arbiter, run);
  console.log(
    `${run.result.paidTo} received ${run.result.recipientReceivedStroops} stroops (${run.result.recipientSharePercent}%), fee ${run.result.feeStroops} to ${run.result.feeTo}; ${run.result.oneSignatureRefused.join("; ")}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
