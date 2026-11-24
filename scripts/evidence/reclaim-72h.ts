// Reclaims the balance abandon-72h.ts opened for one asset, once its 72-hour
// window has closed. Refuses early with the time remaining; the chain would
// reject an early reclaim anyway (op_cannot_claim).
//
//   pnpm tsx scripts/evidence/reclaim-72h.ts EURC
//
// Reads .state/abandon-72h-<asset>.json and writes out/reclaim-72h-<asset>.json.

import { Keypair } from "@stellar/stellar-sdk";

import { ASSET_CODES, toAsset, type AssetCode } from "../../lib/stellar/assets";
import { buildClaimTransaction } from "../../lib/stellar/settlement";
import { verifyClaimTx } from "../../lib/stellar/verify";
import {
  latestLedger,
  sourceAccount,
  trySubmit,
} from "../../tests/integration/testnet";
import type { AbandonState } from "./abandon-72h";
import { readState, snapshot, txEvidence, writeOut, writeState } from "./record";

function remaining(ms: number) {
  const m = Math.ceil(ms / 60_000);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function main() {
  const code = process.argv[2] as AssetCode;
  if (!ASSET_CODES.includes(code)) {
    throw new Error(`Usage: reclaim-72h.ts <${ASSET_CODES.join("|")}>`);
  }
  const name = `abandon-72h-${code.toLowerCase()}`;
  const state = readState<AbandonState>(name);
  if (!state) throw new Error(`No .state/${name}.json; run abandon-72h.ts ${code} first.`);

  const closedAt = Date.parse((await latestLedger()).closed_at);
  const pending = state.filter((s) => !s.reclaimHash);
  const early = pending.filter((s) => Date.parse(s.maturesAt) > closedAt);
  if (early.length) {
    for (const s of early) {
      console.error(
        `${s.asset} balance ${s.balanceId} matures ${s.maturesAt}: ${remaining(Date.parse(s.maturesAt) - closedAt)} to go.`,
      );
    }
    throw new Error("Refusing to reclaim before the 72-hour window has closed.");
  }

  for (const s of pending) {
    const seller = Keypair.fromSecret(s.sellerSecret);
    const asset = toAsset(s.asset);
    const before = await snapshot("seller before reclaim", seller, asset);
    const sub = await trySubmit(
      buildClaimTransaction(await sourceAccount(seller), s.balanceId),
      seller,
    );
    if (!sub.ok) throw new Error(`${s.asset} reclaim rejected: ${sub.codes.join(", ")}`);
    await verifyClaimTx(sub.hash, s.balanceId);
    s.reclaimHash = sub.hash;
    s.reclaim = {
      ...(await txEvidence("seller reclaims after 72 hours", sub)),
      snapshots: [before, await snapshot("seller after reclaim", seller, asset)],
    };
    writeState(name, state);
  }

  const results = state.map(({ sellerSecret: _, ...pub }) => pub);
  writeOut(`reclaim-72h-${code.toLowerCase()}`, results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
