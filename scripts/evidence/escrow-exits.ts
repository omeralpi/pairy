// Evidence runs for protected trades (D2 §9): a Trustless Work escrow with
// Pairy's roles on testnet, from creation to one of its exits.
//
//   pnpm tsx scripts/evidence/escrow-exits.ts release [--arbiter=test|real]
//
// release (Gate D2): a fresh creation key deploys the escrow, the seller funds
// it, and the seller alone releases it to the buyer. --arbiter picks the
// dispute resolver the escrow names: the test 2-of-2 from
// scripts/evidence/.state/arbiter-test.json (the default, for repeated runs)
// or ARBITER_ACCOUNT (the evidence run, DECISIONS 14). A release never needs
// the resolver's signature. The dispute exits are WP-15's.
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
// Appends one run to scripts/evidence/out/escrow-release-<arbiter>.json and
// keeps the earlier ones (FIXES X-05).

import path from "node:path";

import {
  Address,
  Keypair,
  TransactionBuilder,
  TransactionFailedError,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import dotenv from "dotenv";

import {
  ARBITER_ACCOUNT,
  MILESTONE_DESCRIPTION,
  PLATFORM_ACCOUNT,
  TW_ESCROW_WASM_HASH,
  TW_FEE_ADDRESS,
  USDC_SAC,
  twViewerUrl,
} from "../../lib/escrow/config";
import { makeCreationKey, type Signer } from "../../lib/escrow/creation-key";
import { netAfterFee, twFee } from "../../lib/escrow/fee";
import { decodeEscrowCall, validateEscrowCall, type CallExpectation, type EscrowTerms } from "../../lib/escrow/xdr";
import { fundWithFriendbot, horizon } from "../../lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "../../lib/stellar/settlement";
import { TW_ENDPOINTS, twAmount, twCall, type TwInput, type TwOutput } from "../../server/tw/client";
import {
  USDC,
  acquire,
  addUsdcTrustline,
  balanceStroops,
  freshAccount,
  toStroops,
  txRecord,
  type Submitted,
} from "../../tests/integration/testnet";
import type { ArbiterTestState } from "../ops/setup-arbiter";
import { readOut, readState, txEvidence, writeOut } from "./record";

const AMOUNT = "5.0000000";
const soroban = new rpc.Server("https://soroban-testnet.stellar.org");

type Arbiter = "test" | "real";
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

/** Sends a signed transaction to Horizon, as the browser does. */
async function send(step: string, signedXdr: string): Promise<Submitted> {
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
    throw new Error(`${step} ${hash} rejected: ${[transaction, ...operations].join(", ")}`);
  }
}

/**
 * Reads a landed escrow transaction back from Horizon by hash (FIXES F-02,
 * X-09): it is the transaction Trustless Work prepared and Pairy checked, it
 * still passes the check at its ledger's close time, only `signer` signed it,
 * and its operation record names the same contract and function. The USDC it
 * moved comes from the operation's asset_balance_changes.
 */
async function readBack(hash: string, preparedHash: string, signer: string, expectation: CallExpectation) {
  const rec = await txRecord(hash);
  check(rec.successful, `${hash} failed on chain.`);
  const landed = decodeEscrowCall({ unsignedXdr: rec.envelope_xdr, txHash: hash });
  check(landed.hash === preparedHash, `${hash} is not the transaction Trustless Work prepared (${preparedHash}).`);
  const problems = validateEscrowCall(landed, expectation, new Date(rec.created_at));
  check(!problems.length, `${hash} on chain fails the check:\n- ${problems.join("\n- ")}`);

  const key = Keypair.fromPublicKey(signer);
  const bySigner = rec.signatures.filter((s) => key.verify(Buffer.from(hash, "hex"), Buffer.from(s, "base64")));
  check(
    rec.signatures.length === 1 && bySigner.length === 1,
    `${hash} carries ${rec.signatures.length} signatures, ${bySigner.length} of them by ${signer}; expected that one alone.`,
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
  return { source: rec.source_account, signedBy: [signer], contract: String(contract), fn: String(fn), transfers };
}

/** Trustless Work prepares, Pairy checks, the wallet signs, Horizon takes it, Horizon is read back. */
async function step<E extends "deploy" | "fund" | "approveAndRelease">(
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
  const back = await readBack(sub.hash, prepared.txHash, wallet.publicKey, expectation);
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

async function release(arbiter: Arbiter) {
  const startedAt = new Date().toISOString();
  const resolver = resolverFor(arbiter);
  const amountStroops = toStroops(AMOUNT);

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

  // Pairy's role mapping (DECISIONS 3, S-16): the seller approves and releases, the buyer receives.
  const terms: EscrowTerms = {
    admin: creation.publicKey,
    platform: PLATFORM_ACCOUNT,
    receiver: buyer,
    approvers: [seller.publicKey],
    releaseSigners: [seller.publicKey],
    disputeResolvers: [resolver],
    serviceProviders: [seller.publicKey],
    amountStroops,
    platformFeePercent: 0,
    tokenContract: USDC_SAC,
    milestones: [{ description: MILESTONE_DESCRIPTION }],
  };

  const before = await holdings("before deploy", parties, null);
  check(before.seller === amountStroops && before.buyer === 0n, `The seller holds ${before.seller} and the buyer ${before.buyer} stroops of USDC.`);

  const deploy = await step(
    "deploy",
    "deploy",
    {
      signer: creation.publicKey,
      engagementId: `pairy-evidence-release-${Date.now()}`,
      title: "Pairy protected trade",
      description: "Pairy evidence run: release exit, Stellar testnet",
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
    approvers: [seller.publicKey],
    dispute_resolvers: [resolver],
    platform: PLATFORM_ACCOUNT,
    receiver: buyer,
    release_signers: [seller.publicKey],
    service_providers: [seller.publicKey],
  };
  const pairyRoles = Object.fromEntries(Object.keys(expectedRoles).map((k) => [k, created.roles[k]]));
  check(JSON.stringify(pairyRoles) === JSON.stringify(expectedRoles), `The escrow's roles on chain are ${JSON.stringify(created.roles)}.`);
  check(created.amountStroops === String(amountStroops) && !created.released && !created.disputed, "The escrow on chain is not a fresh 5 USDC escrow.");
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

type Out = { exit: "release"; arbiter: Arbiter; runs: unknown[] };

async function main() {
  dotenv.config({ path: path.join(__dirname, "../../.env.local"), quiet: true });
  const [exit, ...flags] = process.argv.slice(2);
  const arbiter = flags.length ? flags[0].replace(/^--arbiter=/, "") : "test";
  if (exit !== "release" || flags.length > 1 || (arbiter !== "test" && arbiter !== "real")) {
    throw new Error("Usage: escrow-exits.ts release [--arbiter=test|real]");
  }
  const run = await release(arbiter);
  const name = `escrow-release-${arbiter}`;
  const prev = readOut<Out>(name);
  writeOut(name, { exit: "release", arbiter, runs: [...(prev?.runs ?? []), run] } satisfies Out);
  console.log(
    `buyer received ${run.result.buyerReceivedStroops} stroops (${run.result.buyerSharePercent}%), fee ${run.result.feeStroops} to ${run.result.feeTo}`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
