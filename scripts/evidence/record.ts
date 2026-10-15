// Shared recording for the evidence scripts: what each transaction cost and
// what it did to the seller's balance and reserve, read back from Horizon.

import fs from "node:fs";
import path from "node:path";

import { Asset, type Keypair } from "@stellar/stellar-sdk";

import { explorerTxUrl } from "../../lib/stellar/horizon";
import {
  balanceStroops,
  latestLedger,
  loadAccount,
  txRecord,
  type Submitted,
} from "../../tests/integration/testnet";

const OUT_DIR = path.join(__dirname, "out");
const STATE_DIR = path.join(__dirname, ".state");

export async function txEvidence(step: string, sub: Submitted) {
  const rec = await txRecord(sub.hash);
  return {
    step,
    hash: sub.hash,
    url: explorerTxUrl(sub.hash),
    successful: rec.successful,
    resultCodes: sub.ok ? null : sub.codes,
    ledger: rec.ledger_attr,
    closedAt: rec.created_at,
    feeChargedStroops: String(rec.fee_charged),
  };
}

/**
 * The reserve never leaves the balance; it raises the account's minimum
 * balance. So both are recorded, and the reserve a lock ties up is the
 * change in `minimumBalanceStroops`.
 */
export async function snapshot(label: string, kp: Keypair, asset: Asset) {
  const [acc, ledger] = await Promise.all([loadAccount(kp), latestLedger()]);
  const baseReserve = BigInt(ledger.base_reserve_in_stroops);
  const entries = 2n + BigInt(acc.subentry_count) +
    BigInt(acc.num_sponsoring) - BigInt(acc.num_sponsored);
  return {
    label,
    account: kp.publicKey(),
    at: ledger.closed_at,
    xlmBalanceStroops: String(balanceStroops(acc, Asset.native())),
    ...(asset.isNative()
      ? {}
      : { [`${asset.code}BalanceStroops`]: String(balanceStroops(acc, asset)) }),
    numSponsoring: acc.num_sponsoring,
    baseReserveStroops: String(baseReserve),
    minimumBalanceStroops: String(entries * baseReserve),
  };
}

export function writeOut(name: string, data: unknown) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

/** Throwaway testnet secrets live here, never in out/ (gitignored). */
export function writeState(name: string, data: unknown) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(STATE_DIR, `${name}.json`),
    JSON.stringify(data, null, 2) + "\n",
    { mode: 0o600 },
  );
}

export function readState<T>(name: string): T | null {
  const file = path.join(STATE_DIR, `${name}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
