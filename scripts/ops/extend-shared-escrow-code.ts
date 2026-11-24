// Keeps alive on testnet, past day 30 (2026-12-23) with margin, the Trustless
// Work storage that every protected-trade escrow shares (O-21; WP-14's C-1)
// and the escrows the evidence links (O-46, WP-47). SDF cancelled the 16 Dec
// 2026 testnet reset (O-46), so storage rent, not a reset, is what ends them.
// Once the factory's instance and the escrow code are archived, restoring them
// inside an escrow call costs about 8.7 XLM, above the 2 XLM Pairy lets an
// escrow transaction cost (O-18). An escrow's own instance and ["Escrow"] entry
// archive about 7 days after its deploy, and the day-30 checks open the
// evidence escrows on Trustless Work's viewer.
//
// Which entries: the Soroban entries in the footprints of the deploy, fund,
// release, dispute and resolve calls Trustless Work prepared
// (tests/fixtures/tw) that serve more than one escrow, plus the pinned factory,
// escrow code and USDC contract (lib/escrow/config.ts) and the EURC contract's
// instance; and each EVIDENCE_ESCROWS escrow's instance, ["Escrow"] entry and
// USDC balance entry (extend-targets.ts). Any other escrow's own entries are
// left to its trade (WP-14's decision in docs/phase2-gates.md).
//
// Prints each entry's liveUntilLedgerSeq and simulates one ExtendFootprintTTL
// for those that expire before TARGET (2027-01-10 00:00 UTC, day 30 plus
// margin). Changes nothing unless --apply is given. With --apply, a fresh
// Friendbot account whose key exists only in memory signs and sends it, if the
// fee is at most 20 XLM; every entry is then read back. Extending a TTL is
// open to anyone: it moves no funds and needs no contract's authorization.
// Re-runnable: only entries that are short are extended. Each applied run is
// appended to scripts/evidence/out/extend-shared-escrow-code.json.
//
//   pnpm tsx scripts/ops/extend-shared-escrow-code.ts
//   pnpm tsx scripts/ops/extend-shared-escrow-code.ts --apply

import fs from "node:fs";
import path from "node:path";

import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  contract,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

import { TW_ESCROW_WASM_HASH, TW_FACTORY_CONTRACT_ID, USDC_SAC } from "../../lib/escrow/config";
import { explorerAccountUrl, explorerTxUrl, soroban } from "../../lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "../../lib/stellar/settlement";
import { freshAccount, latestLedger, signAndSubmit, sourceAccount, txRecord } from "../../tests/integration/testnet";
import { readOut, writeOut } from "../evidence/record";
import { EVIDENCE_ESCROWS, TARGET, escrowEntries, instanceOf } from "./extend-targets";

const LEDGER_SECONDS = 5;
const MAX_FEE_STROOPS = 200_000_000n; // 20 XLM
/** Circle's testnet EURC (home domain circle.com). lib/stellar/assets.ts brings it to this branch with merge M2. */
const EURC_ISSUER = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";
const EURC_SAC = new Asset("EURC", EURC_ISSUER).contractId(NETWORK_PASSPHRASE);
const FIXTURES = path.join(__dirname, "../../tests/fixtures/tw");
const OUT = "extend-shared-escrow-code";

const NAMES: Record<string, string> = {
  ...(TW_FACTORY_CONTRACT_ID ? { [TW_FACTORY_CONTRACT_ID]: "factory" } : {}),
  [USDC_SAC]: "USDC contract",
  [EURC_SAC]: "EURC contract",
  ...Object.fromEntries(EVIDENCE_ESCROWS.map((id) => [id, `escrow ${id}`])),
};

const codeOf = (wasmHashHex: string) =>
  xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHashHex, "hex") }));

function label(key: xdr.LedgerKey): string {
  if (key.type === "contractCode") {
    const h = Buffer.from(key.contractCode.hash.value).toString("hex");
    return h === TW_ESCROW_WASM_HASH ? `escrow code ${h}` : `contract code ${h}`;
  }
  if (key.type !== "contractData") return key.type;
  const c = Address.fromScAddress(key.contractData.contract).toString();
  const what = key.contractData.key.type === "scvLedgerKeyContractInstance" ? "instance" : JSON.stringify(scValToNative(key.contractData.key));
  return `${NAMES[c] ?? c} ${what}`;
}

type Prepared = { unsignedXdr: string; contractId?: string };

/** Every transaction Trustless Work prepared in the recorded runs (a file may hold several). */
function recordedCalls(): Prepared[] {
  return fs
    .readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const d = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8"));
      return ((d.envelopes ?? [d]) as { response?: { body?: Partial<Prepared> } }[])
        .map((r) => r.response?.body)
        .filter((b): b is Prepared => typeof b?.unsignedXdr === "string");
    });
}

/**
 * The Soroban entries (contract code and data, the ones with a TTL) that the
 * recorded calls of more than one escrow touch. A deploy is for the escrow it
 * creates; every other call for the contract it calls.
 */
function sharedFromRecordedCalls(): xdr.LedgerKey[] {
  const escrows = new Map<string, { key: xdr.LedgerKey; escrows: Set<string> }>();
  for (const p of recordedCalls()) {
    const env = xdr.TransactionEnvelope.fromXDR(p.unsignedXdr, "base64");
    if (env.type !== "envelopeTypeTx" || env.v1.tx.ext.type !== "sorobanData") continue;
    const body = env.v1.tx.operations[0]?.body;
    if (body?.type !== "invokeHostFunction" || body.invokeHostFunctionOp.hostFunction.type !== "hostFunctionTypeInvokeContract") continue;
    const escrow = p.contractId ?? Address.fromScAddress(body.invokeHostFunctionOp.hostFunction.invokeContract.contractAddress).toString();
    const { readOnly, readWrite } = env.v1.tx.ext.sorobanData.resources.footprint;
    for (const key of [...readOnly, ...readWrite]) {
      if (key.type !== "contractCode" && key.type !== "contractData") continue;
      const id = key.toXDR("base64");
      const e = escrows.get(id) ?? { key, escrows: new Set<string>() };
      e.escrows.add(escrow);
      escrows.set(id, e);
    }
  }
  return [...escrows.values()].filter((e) => e.escrows.size > 1).map((e) => e.key);
}

function candidates(): xdr.LedgerKey[] {
  const pinned = [
    ...(TW_ESCROW_WASM_HASH ? [codeOf(TW_ESCROW_WASM_HASH)] : []),
    ...(TW_FACTORY_CONTRACT_ID ? [instanceOf(TW_FACTORY_CONTRACT_ID)] : []),
    instanceOf(USDC_SAC),
    instanceOf(EURC_SAC),
  ];
  const byId = new Map([...pinned, ...sharedFromRecordedCalls(), ...EVIDENCE_ESCROWS.flatMap(escrowEntries)].map((k) => [k.toXDR("base64"), k] as const));
  return [...byId.values()];
}

async function liveUntil(keys: xdr.LedgerKey[], atLeastLedger = 0) {
  for (let i = 0; i < 30; i++) {
    const res = await soroban.getLedgerEntries(...keys);
    if (res.latestLedger >= atLeastLedger) {
      const byId = new Map(res.entries.map((e) => [e.key.toXDR("base64"), e.liveUntilLedgerSeq ?? 0]));
      return { latestLedger: res.latestLedger, of: (k: xdr.LedgerKey) => byId.get(k.toXDR("base64")) ?? null };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Soroban RPC has not reached ledger ${atLeastLedger} after 30 tries.`);
}

function extendTx(source: Account, keys: xdr.LedgerKey[], extendTo: number) {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .setSorobanData(new SorobanDataBuilder().setReadOnly(keys).build())
    .addOperation(Operation.extendFootprintTtl({ extendTo }))
    .setTimeout(300)
    .build();
}

const xlm = (stroops: bigint) => `${Number(stroops) / 1e7} XLM`;

async function main() {
  const apply = process.argv.includes("--apply");
  const keys = candidates();

  // Ledger numbers to dates: Horizon's latest closed ledger, 5 s per ledger.
  const ledger = await latestLedger();
  const closedAt = Date.parse(ledger.closed_at);
  const about = (seq: number) => new Date(closedAt + (seq - ledger.sequence) * LEDGER_SECONDS * 1000).toISOString();
  const targetLedger = ledger.sequence + Math.ceil((TARGET.getTime() - closedAt) / 1000 / LEDGER_SECONDS);

  const before = await liveUntil(keys);
  const entries = keys.map((key) => {
    const until = before.of(key);
    return { label: label(key), key: key.toXDR("base64"), liveUntilBefore: until, beforeAbout: until ? about(until) : null, short: until !== null && until < targetLedger };
  });
  console.log(`target: live until ledger ${targetLedger} (${TARGET.toISOString()}); latest ledger ${before.latestLedger}`);
  for (const e of entries) {
    const state = e.liveUntilBefore === null ? "not on the ledger" : `until ${e.liveUntilBefore} (about ${e.beforeAbout})`;
    console.log(`  ${e.short ? "SHORT" : "ok   "} ${e.label}: ${state}`);
  }
  const archived = entries.filter((e) => e.liveUntilBefore !== null && e.liveUntilBefore < before.latestLedger);
  if (archived.length) throw new Error(`Archived, so it must be restored, not extended: ${archived.map((e) => e.label).join(", ")}.`);

  const short = keys.filter((_, i) => entries[i].short);
  if (!short.length) {
    console.log("Nothing to extend: every entry lives past the target.");
    if (apply) appendRun({ at: new Date().toISOString(), targetLedger, target: TARGET.toISOString(), entries, tx: null });
    return;
  }

  // Simulate first, from no account at all; nothing is signed or sent.
  const extendTo = targetLedger - before.latestLedger;
  const sim = await soroban.simulateTransaction(extendTx(new Account(contract.NULL_ACCOUNT, "0"), short, extendTo));
  if (!rpc.Api.isSimulationSuccess(sim)) throw new Error(`The simulation failed: ${"error" in sim ? sim.error : "no result"}`);
  const simulatedFee = BigInt(BASE_FEE) + BigInt(sim.minResourceFee);
  console.log(`extend ${short.length} entries by up to ${extendTo} ledgers: simulated fee ${xlm(simulatedFee)}`);
  if (simulatedFee > MAX_FEE_STROOPS) throw new Error(`The fee ${xlm(simulatedFee)} is above the ${xlm(MAX_FEE_STROOPS)} budget (O-21). Nothing was sent.`);
  if (!apply) {
    console.log("Nothing sent. Run again with --apply to extend.");
    return;
  }

  const kp = await freshAccount();
  const tx = (await soroban.prepareTransaction(extendTx(await sourceAccount(kp), short, extendTo))) as Transaction;
  if (BigInt(tx.fee) > MAX_FEE_STROOPS) throw new Error(`The prepared fee ${xlm(BigInt(tx.fee))} is above the budget. Nothing was sent.`);
  const { hash } = await signAndSubmit(tx, kp);
  const rec = await txRecord(hash);

  const after = await liveUntil(keys, rec.ledger_attr);
  const done = entries.map((e, i) => {
    const until = after.of(keys[i]);
    return { ...e, liveUntilAfter: until, afterAbout: until ? about(until) : null };
  });
  const stillShort = done.filter((e) => e.short && (e.liveUntilAfter ?? 0) < targetLedger);
  if (stillShort.length) throw new Error(`Still short after ${hash}: ${stillShort.map((e) => e.label).join(", ")}.`);

  appendRun({
    at: rec.created_at,
    targetLedger,
    target: TARGET.toISOString(),
    entries: done,
    tx: {
      hash,
      url: explorerTxUrl(hash),
      ledger: rec.ledger_attr,
      source: kp.publicKey(),
      extendTo,
      simulatedFeeStroops: String(simulatedFee),
      maxFeeStroops: tx.fee,
      feeChargedStroops: String(rec.fee_charged),
    },
  });
  for (const e of done) if (e.short) console.log(`  ${e.label}: ${e.liveUntilBefore} -> ${e.liveUntilAfter} (about ${e.afterAbout})`);
  console.log(`extended in ${hash}, fee charged ${xlm(BigInt(rec.fee_charged))}`);
  console.log(`  ${explorerTxUrl(hash)}`);
  console.log(`  paid by ${explorerAccountUrl(kp.publicKey())} (Friendbot; its key was never written down)`);
}

/** Earlier runs are kept (WP-46 runs this again if a testnet reset is announced, O-46). */
function appendRun(run: unknown) {
  const out = readOut<{ runs: unknown[] }>(OUT) ?? { runs: [] };
  out.runs.push(run);
  writeOut(OUT, out);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
