// Lock, claim and reclaim against the real Stellar testnet, using only the
// settlement.ts builders. The test is the wallet: it signs with throwaway
// Friendbot-funded keys. Run with `pnpm test:testnet`.

import { Asset, type Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { ASSET_CODES, needsTrustline, toAsset, type AssetCode } from "../../lib/stellar/assets";
import {
  buildClaimTransaction,
  buildLockTransaction,
} from "../../lib/stellar/settlement";
import { lockBalanceId, verifyClaimTx, verifyLockTx } from "../../lib/stellar/verify";
import {
  EVIDENCE_AMOUNTS,
  acquire,
  acquireSource,
  addTrustline,
  balanceStroops,
  claimableBalance,
  feeCharged,
  freshAccount,
  loadAccount,
  reclaimOpensAt,
  signAndSubmit,
  sourceAccount,
  toStroops,
  trySubmit,
  waitForLedgerTime,
} from "./testnet";

async function lock(
  seller: Keypair,
  buyer: Keypair,
  asset: Asset,
  amount: string,
  windowSeconds?: number,
) {
  const tx = buildLockTransaction(await sourceAccount(seller), {
    asset,
    amount,
    buyer: buyer.publicKey(),
    windowSeconds,
  });
  const res = await signAndSubmit(tx, seller);
  return { ...res, balanceId: lockBalanceId(tx) };
}

async function claim(claimant: Keypair, balanceId: string) {
  const tx = buildClaimTransaction(await sourceAccount(claimant), balanceId);
  return trySubmit(tx, claimant);
}

function settlementSuite(code: AssetCode, setup: () => Promise<[Keypair, Keypair]>) {
  const asset = toAsset(code);
  const amount = EVIDENCE_AMOUNTS[code];

  it(`${code}: lock → buyer claims; balance gone, buyer paid, reserve back to seller`, async () => {
    const [seller, buyer] = await setup();
    const sellerBefore = await loadAccount(seller);
    const buyerBefore = await loadAccount(buyer);

    const locked = await lock(seller, buyer, asset, amount);
    const lockFee = await feeCharged(locked.hash);
    const sellerLocked = await loadAccount(seller);

    // The entry's reserve (one base reserve per claimant) is sponsored by the seller.
    const cb = await claimableBalance(locked.balanceId);
    expect(cb?.sponsor).toBe(seller.publicKey());
    expect(sellerLocked.num_sponsoring - sellerBefore.num_sponsoring).toBe(2);
    expect(balanceStroops(sellerBefore, asset) - balanceStroops(sellerLocked, asset))
      .toBe(toStroops(amount) + (asset.isNative() ? lockFee : 0n));

    await expect(
      verifyLockTx(locked.hash, {
        seller: seller.publicKey(),
        buyer: buyer.publicKey(),
        asset: code,
        amount,
        windowSeconds: 259_200,
      }),
    ).resolves.toMatchObject({ balanceId: locked.balanceId, createdAt: expect.any(Date) });

    const claimed = await claim(buyer, locked.balanceId);
    expect(claimed.ok).toBe(true);
    const claimFee = await feeCharged(claimed.hash);

    expect(await claimableBalance(locked.balanceId)).toBeNull();
    const buyerAfter = await loadAccount(buyer);
    expect(balanceStroops(buyerAfter, asset) - balanceStroops(buyerBefore, asset))
      .toBe(toStroops(amount) - (asset.isNative() ? claimFee : 0n));

    // The reserve returns to the seller, not to the buyer who claimed.
    const sellerAfter = await loadAccount(seller);
    expect(sellerAfter.num_sponsoring).toBe(sellerBefore.num_sponsoring);
    expect(buyerAfter.num_sponsoring).toBe(buyerBefore.num_sponsoring);
    expect(balanceStroops(sellerAfter, Asset.native()))
      .toBe(balanceStroops(sellerLocked, Asset.native()));

    await expect(verifyClaimTx(claimed.hash, locked.balanceId)).resolves.toEqual({
      claimant: buyer.publicKey(),
    });
    console.log(`${code} claim path`, { lock: locked.hash, claim: claimed.hash, lockFee, claimFee });
  });

  it(`${code}: 60s lock; early reclaim rejected on-chain, reclaim after the window succeeds`, async () => {
    const [seller, buyer] = await setup();
    const sellerBefore = await loadAccount(seller);

    const locked = await lock(seller, buyer, asset, amount, 60);
    await expect(
      verifyLockTx(locked.hash, {
        seller: seller.publicKey(),
        buyer: buyer.publicKey(),
        asset: code,
        amount,
        windowSeconds: 60,
      }),
    ).resolves.toMatchObject({ balanceId: locked.balanceId, createdAt: expect.any(Date) });

    const early = await claim(seller, locked.balanceId);
    expect(early).toMatchObject({ ok: false, codes: ["tx_failed", "op_cannot_claim"] });
    expect(await claimableBalance(locked.balanceId)).not.toBeNull();

    await waitForLedgerTime(await reclaimOpensAt(locked.balanceId, seller.publicKey()));

    const reclaimed = await claim(seller, locked.balanceId);
    expect(reclaimed.ok).toBe(true);
    expect(await claimableBalance(locked.balanceId)).toBeNull();

    // Everything comes back except the three fees (lock, failed reclaim, reclaim).
    const fees =
      (await feeCharged(locked.hash)) +
      (await feeCharged(early.hash)) +
      (await feeCharged(reclaimed.hash));
    const sellerAfter = await loadAccount(seller);
    expect(sellerAfter.num_sponsoring).toBe(sellerBefore.num_sponsoring);
    expect(balanceStroops(sellerBefore, Asset.native()) - balanceStroops(sellerAfter, Asset.native()))
      .toBe(fees);
    expect(balanceStroops(sellerAfter, asset)).toBe(balanceStroops(sellerBefore, asset) - (asset.isNative() ? fees : 0n));

    await expect(verifyClaimTx(reclaimed.hash, locked.balanceId)).resolves.toEqual({
      claimant: seller.publicKey(),
    });
    console.log(`${code} reclaim path`, {
      lock: locked.hash,
      earlyReclaim: early.hash,
      earlyCodes: early.ok ? null : early.codes,
      reclaim: reclaimed.hash,
    });
  });
}

describe("XLM settlement on testnet", () => {
  settlementSuite("XLM", () => Promise.all([freshAccount(), freshAccount()]));
});

// Set by testnet.yml on manual runs (REQUIRE_ASSETS=USDC), so a skipped suite
// cannot pass silently there. EURC comes from a local treasury (HX-7) that CI
// never holds: require it on local runs with REQUIRE_ASSETS=USDC,EURC.
const required = new Set((process.env.REQUIRE_ASSETS ?? "").split(",").filter(Boolean));

for (const code of ASSET_CODES.filter(needsTrustline)) {
  const asset = toAsset(code);
  const amount = EVIDENCE_AMOUNTS[code];
  const source = await acquireSource(code, amount);
  if (!source) {
    console.warn(
      `WARNING: ${code} testnet tests SKIPPED: the testnet DEX has no path to ${amount} ${code} and there is no scripts/evidence/.state/treasury-${code.toLowerCase()}.json, so there is no way to fund a seller.${required.has(code) ? ` REQUIRE_ASSETS names ${code}, so this run fails.` : ""}`,
    );
  }

  describe.runIf(!source && required.has(code))(`${code} settlement on testnet (REQUIRE_ASSETS)`, () => {
    it(`has a way to fund a ${code} seller`, () => {
      expect.fail(`Neither the testnet DEX nor a treasury can supply ${amount} ${code}, so the ${code} suite could not run`);
    });
  });

  describe.skipIf(!source)(`${code} settlement on testnet (${source})`, () => {
    async function pair(): Promise<[Keypair, Keypair]> {
      const [seller, buyer] = await Promise.all([freshAccount(), freshAccount()]);
      await Promise.all([addTrustline(seller, code), addTrustline(buyer, code)]);
      await acquire(seller, code, amount);
      return [seller, buyer];
    }

    settlementSuite(code, pair);

    it(`${code}: a buyer with no trustline can be locked to, but cannot claim (op_no_trust) until they add one`, async () => {
      const [seller] = await pair();
      const buyer = await freshAccount();

      // CAP-23 does not check claimants' trustlines at creation.
      const locked = await lock(seller, buyer, asset, amount);

      const noTrust = await claim(buyer, locked.balanceId);
      expect(noTrust).toMatchObject({ ok: false, codes: ["tx_failed", "op_no_trust"] });
      expect(await claimableBalance(locked.balanceId)).not.toBeNull();

      await addTrustline(buyer, code);
      const claimed = await claim(buyer, locked.balanceId);
      expect(claimed.ok).toBe(true);
      expect(balanceStroops(await loadAccount(buyer), asset)).toBe(toStroops(amount));
      console.log(`${code} trustline`, {
        lock: locked.hash,
        claimWithoutTrustline: noTrust.hash,
        claimAfterTrustline: claimed.hash,
      });
    });
  });
}
