// Opens a real 259200-second (72-hour) lock in XLM and in USDC whose buyer
// never claims, so the seller's reclaim matures on its own. Run once; run
// reclaim-72h.ts after maturity.
//
//   pnpm tsx scripts/evidence/abandon-72h.ts
//
// The buyer's secret is never saved: nobody can claim inside the window.

import type { Asset } from "@stellar/stellar-sdk";

import { toAsset, type AssetCode } from "../../lib/stellar/assets";
import {
  CLAIM_WINDOW_SECONDS,
  buildLockTransaction,
  lockBalanceId,
} from "../../lib/stellar/settlement";
import { verifyLockTx } from "../../lib/stellar/verify";
import {
  addUsdcTrustline,
  buyUsdc,
  freshAccount,
  reclaimOpensAt,
  signAndSubmit,
  sourceAccount,
} from "../../tests/integration/testnet";
import { readState, snapshot, txEvidence, writeOut, writeState } from "./record";

const AMOUNT = "5.0000000";

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
  const [seller, buyer] = await Promise.all([freshAccount(), freshAccount()]);
  if (!asset.isNative()) {
    await addUsdcTrustline(seller);
    await addUsdcTrustline(buyer);
    await buyUsdc(seller, "50");
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
  if (readState<AbandonState>("abandon-72h")) {
    throw new Error(
      "scripts/evidence/.state/abandon-72h.json already exists; refusing to overwrite the seller keys of a pending 72-hour lock.",
    );
  }
  const runs = [];
  for (const code of ["XLM", "USDC"] as const) {
    console.log(`${code}: opening abandoned 72-hour lock`);
    runs.push(await abandon(code));
    // Persist after each lock so a later failure never strands a seller key.
    writeState("abandon-72h", runs.map((r) => r.state));
  }
  writeOut("abandon-72h", runs.map((r) => r.pub));
  for (const { pub } of runs) {
    console.log(`${pub.asset} balance ${pub.balanceId} matures ${pub.maturesAt}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
