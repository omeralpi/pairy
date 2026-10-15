// Evidence run: a lock + buyer claim (72-hour window) and a lock + early
// reclaim attempt + reclaim (60-second window, waited out), on testnet.
//
//   pnpm tsx scripts/evidence/settlement.ts XLM
//   pnpm tsx scripts/evidence/settlement.ts USDC
//
// Writes scripts/evidence/out/settlement-<asset>.json.

import { Asset, type Keypair } from "@stellar/stellar-sdk";

import { ASSET_CODES, toAsset, type AssetCode } from "../../lib/stellar/assets";
import {
  CLAIM_WINDOW_SECONDS,
  buildClaimTransaction,
  buildLockTransaction,
  lockBalanceId,
} from "../../lib/stellar/settlement";
import { verifyClaimTx, verifyLockTx } from "../../lib/stellar/verify";
import {
  addUsdcTrustline,
  buyUsdc,
  freshAccount,
  reclaimOpensAt,
  signAndSubmit,
  sourceAccount,
  trySubmit,
  waitForLedgerTime,
} from "../../tests/integration/testnet";
import { snapshot, txEvidence, writeOut, writeState } from "./record";

const AMOUNT = "5.0000000";

async function lock(seller: Keypair, buyer: Keypair, asset: Asset, windowSeconds: number) {
  const tx = buildLockTransaction(await sourceAccount(seller), {
    asset,
    amount: AMOUNT,
    buyer: buyer.publicKey(),
    windowSeconds,
  });
  return { sub: await signAndSubmit(tx, seller), balanceId: lockBalanceId(tx) };
}

async function claim(claimant: Keypair, balanceId: string) {
  return trySubmit(
    buildClaimTransaction(await sourceAccount(claimant), balanceId),
    claimant,
  );
}

async function main() {
  const code = process.argv[2] as AssetCode;
  if (!ASSET_CODES.includes(code)) {
    throw new Error(`Usage: settlement.ts <${ASSET_CODES.join("|")}>`);
  }
  const asset = toAsset(code);
  const name = `settlement-${code.toLowerCase()}`;

  const [seller, buyer] = await Promise.all([freshAccount(), freshAccount()]);
  writeState(name, { seller: seller.secret(), buyer: buyer.secret() });
  const setup = [];
  if (!asset.isNative()) {
    setup.push(await txEvidence("seller trustline", await addUsdcTrustline(seller)));
    setup.push(await txEvidence("buyer trustline", await addUsdcTrustline(buyer)));
    setup.push(await txEvidence("seller buys USDC on the DEX", await buyUsdc(seller, "50")));
  }
  const expected = {
    seller: seller.publicKey(),
    buyer: buyer.publicKey(),
    asset: code,
    amount: AMOUNT,
  };

  console.log(`${code}: lock → buyer claims`);
  const claimPath = { snapshots: [] as unknown[], steps: [] as unknown[] };
  claimPath.snapshots.push(await snapshot("seller before lock", seller, asset));
  const l1 = await lock(seller, buyer, asset, CLAIM_WINDOW_SECONDS);
  await verifyLockTx(l1.sub.hash, { ...expected, windowSeconds: CLAIM_WINDOW_SECONDS });
  claimPath.steps.push({
    ...(await txEvidence(`lock (${CLAIM_WINDOW_SECONDS}s window)`, l1.sub)),
    balanceId: l1.balanceId,
  });
  claimPath.snapshots.push(await snapshot("seller after lock", seller, asset));
  claimPath.snapshots.push(await snapshot("buyer before claim", buyer, asset));
  const c1 = await claim(buyer, l1.balanceId);
  if (!c1.ok) throw new Error(`Buyer claim rejected: ${c1.codes.join(", ")}`);
  await verifyClaimTx(c1.hash, l1.balanceId);
  claimPath.steps.push(await txEvidence("buyer claims", c1));
  claimPath.snapshots.push(await snapshot("seller after claim", seller, asset));
  claimPath.snapshots.push(await snapshot("buyer after claim", buyer, asset));

  console.log(`${code}: 60s lock → early reclaim → reclaim`);
  const reclaimPath = { snapshots: [] as unknown[], steps: [] as unknown[] };
  reclaimPath.snapshots.push(await snapshot("seller before lock", seller, asset));
  const l2 = await lock(seller, buyer, asset, 60);
  await verifyLockTx(l2.sub.hash, { ...expected, windowSeconds: 60 });
  const opensAt = await reclaimOpensAt(l2.balanceId, seller.publicKey());
  reclaimPath.steps.push({
    ...(await txEvidence("lock (60s window)", l2.sub)),
    balanceId: l2.balanceId,
    reclaimOpensAt: new Date(opensAt * 1000).toISOString(),
  });
  reclaimPath.snapshots.push(await snapshot("seller after lock", seller, asset));
  const early = await claim(seller, l2.balanceId);
  if (early.ok) throw new Error("Seller reclaimed inside the window; the lock is broken.");
  reclaimPath.steps.push(await txEvidence("seller reclaims early (rejected)", early));
  await waitForLedgerTime(opensAt);
  const r2 = await claim(seller, l2.balanceId);
  if (!r2.ok) throw new Error(`Reclaim rejected: ${r2.codes.join(", ")}`);
  await verifyClaimTx(r2.hash, l2.balanceId);
  reclaimPath.steps.push(await txEvidence("seller reclaims after window", r2));
  reclaimPath.snapshots.push(await snapshot("seller after reclaim", seller, asset));

  writeOut(name, {
    asset: code,
    amount: AMOUNT,
    network: "testnet",
    seller: seller.publicKey(),
    buyer: buyer.publicKey(),
    setup,
    claimPath,
    reclaimPath,
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
