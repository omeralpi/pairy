// Opens a real 259200-second (72-hour) lock in one asset whose buyer never
// claims, so the seller's reclaim matures on its own. Run once per asset; run
// reclaim-72h.ts <asset> after maturity.
//
//   pnpm tsx scripts/evidence/abandon-72h.ts EURC
//
// State and output are per asset (abandon-72h-<asset>), so a new run never
// touches the XLM/USDC record Phase 1 made as abandon-72h.json (G24). XLM and
// USDC lock 5; EURC locks 1 (FIXES X-04).
//
// The buyer's secret is never saved: nobody can claim inside the window.

import type { Asset } from "@stellar/stellar-sdk";

import { ASSET_CODES, needsTrustline, toAsset, type AssetCode } from "../../lib/stellar/assets";
import {
  CLAIM_WINDOW_SECONDS,
  buildLockTransaction,
} from "../../lib/stellar/settlement";
import { lockBalanceId, verifyLockTx } from "../../lib/stellar/verify";
import {
  EVIDENCE_AMOUNTS,
  acquire,
  addTrustline,
  freshAccount,
  reclaimOpensAt,
  signAndSubmit,
  sourceAccount,
} from "../../tests/integration/testnet";
import { readState, snapshot, txEvidence, writeOut, writeState } from "./record";

export type AbandonState = {
  asset: AssetCode;
  sellerSecret: string;
  seller: string;
  buyer: string;
  balanceId: string;
  lockHash: string;
  createdAt: string;
  maturesAt: string;
  reclaimHash?: string;
  /** Public evidence of the reclaim, filled in by reclaim-72h.ts. */
  reclaim?: unknown;
}[];

async function abandon(code: AssetCode) {
  const asset: Asset = toAsset(code);
  const AMOUNT = EVIDENCE_AMOUNTS[code];
  const [seller, buyer] = await Promise.all([freshAccount(), freshAccount()]);
  if (needsTrustline(code)) {
    await addTrustline(seller, code);
    await addTrustline(buyer, code);
    await acquire(seller, code, AMOUNT);
  }
  const before = await snapshot("seller before lock", seller, asset);
  const tx = buildLockTransaction(await sourceAccount(seller), {
    asset,
    amount: AMOUNT,
    buyer: buyer.publicKey(),
  });
  const sub = await signAndSubmit(tx, seller);
  const balanceId = lockBalanceId(tx);
  await verifyLockTx(sub.hash, {
    seller: seller.publicKey(),
    buyer: buyer.publicKey(),
    asset: code,
    amount: AMOUNT,
    windowSeconds: CLAIM_WINDOW_SECONDS,
  });
  const lock = await txEvidence(`lock (${CLAIM_WINDOW_SECONDS}s window)`, sub);
  const maturesAt = new Date(
    (await reclaimOpensAt(balanceId, seller.publicKey())) * 1000,
  ).toISOString();
  const after = await snapshot("seller after lock", seller, asset);

  const state = {
    asset: code,
    sellerSecret: seller.secret(),
    seller: seller.publicKey(),
    buyer: buyer.publicKey(),
    balanceId,
    lockHash: sub.hash,
    createdAt: lock.closedAt,
    maturesAt,
  };
  const pub = {
    asset: code,
    amount: AMOUNT,
    seller: seller.publicKey(),
    buyer: buyer.publicKey(),
    balanceId,
    lock,
    createdAt: lock.closedAt,
    maturesAt,
    snapshots: [before, after],
  };
  return { state, pub };
}

async function main() {
  const code = process.argv[2] as AssetCode;
  if (!ASSET_CODES.includes(code)) {
    throw new Error(`Usage: abandon-72h.ts <${ASSET_CODES.join("|")}>`);
  }
  const name = `abandon-72h-${code.toLowerCase()}`;
  if (readState<AbandonState>(name)) {
    throw new Error(
      `scripts/evidence/.state/${name}.json already exists; refusing to overwrite the seller key of a pending 72-hour lock.`,
    );
  }
  console.log(`${code}: opening abandoned 72-hour lock`);
  const { state, pub } = await abandon(code);
  writeState(name, [state]);
  writeOut(name, [pub]);
  console.log(`${pub.asset} balance ${pub.balanceId} matures ${pub.maturesAt}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
