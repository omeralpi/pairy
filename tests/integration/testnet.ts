// Testnet plumbing shared by the integration tests and the evidence scripts.
// These play the part of the user's wallet: they hold throwaway keys and sign
// with Keypair.sign. Pairy's own code never does any of this.

import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  NotFoundError,
  Operation,
  TransactionBuilder,
  TransactionFailedError,
  type Transaction,
} from "@stellar/stellar-sdk";

import { TESTNET_USDC_ISSUER } from "../../lib/stellar/assets";
import { fundWithFriendbot, horizon } from "../../lib/stellar/horizon";
import { NETWORK_PASSPHRASE } from "../../lib/stellar/settlement";

export const USDC = new Asset("USDC", TESTNET_USDC_ISSUER);

export type Submitted =
  | { ok: true; hash: string; ledger: number }
  | { ok: false; hash: string; codes: string[] };

export async function freshAccount(): Promise<Keypair> {
  const kp = Keypair.random();
  await fundWithFriendbot(kp.publicKey());
  return kp;
}

export function loadAccount(kp: Keypair) {
  return horizon.loadAccount(kp.publicKey());
}

/** The settlement builders take a plain Account, not Horizon's AccountResponse. */
export async function sourceAccount(kp: Keypair): Promise<Account> {
  const res = await loadAccount(kp);
  return new Account(res.accountId(), res.sequenceNumber());
}

/**
 * Signs and submits. A transaction the network rejects comes back as
 * `ok: false` with its result codes (transaction code first, then one per
 * operation) instead of throwing, because some tests expect rejection.
 */
export async function trySubmit(
  tx: Transaction,
  signer: Keypair,
): Promise<Submitted> {
  tx.sign(signer);
  const hash = Buffer.from(tx.hash()).toString("hex");
  try {
    const res = await horizon.submitTransaction(tx);
    return { ok: true, hash, ledger: res.ledger };
  } catch (e) {
    if (!(e instanceof TransactionFailedError)) throw e;
    const { transaction, operations } = e.getResultCodes();
    return { ok: false, hash, codes: [transaction, ...operations] };
  }
}

export async function signAndSubmit(tx: Transaction, signer: Keypair) {
  const res = await trySubmit(tx, signer);
  if (!res.ok) {
    throw new Error(`Transaction ${res.hash} rejected: ${res.codes.join(", ")}`);
  }
  return res;
}

function setupTx(source: Awaited<ReturnType<typeof loadAccount>>) {
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
}

export async function addUsdcTrustline(kp: Keypair) {
  const tx = setupTx(await loadAccount(kp))
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(300)
    .build();
  return signAndSubmit(tx, kp);
}

/** What `xlm` XLM buys in testnet USDC on the DEX right now, or null if nothing. */
export async function quoteUsdc(xlm: string): Promise<string | null> {
  const { records } = await horizon
    .strictSendPaths(Asset.native(), xlm, [USDC])
    .call();
  return records[0]?.destination_amount ?? null;
}

/** Swaps XLM for testnet USDC into `kp`'s own (already trusted) account. */
export async function buyUsdc(kp: Keypair, xlm: string) {
  const quote = await quoteUsdc(xlm);
  if (!quote) throw new Error("No XLM→USDC path on the testnet DEX.");
  const tx = setupTx(await loadAccount(kp))
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount: xlm,
        destination: kp.publicKey(),
        destAsset: USDC,
        // Allow 10% slippage between quote and execution.
        destMin: (Number(quote) * 0.9).toFixed(7),
        path: [],
      }),
    )
    .setTimeout(300)
    .build();
  return signAndSubmit(tx, kp);
}

/** Horizon amounts always carry 7 decimal places. */
export function toStroops(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole + frac.padEnd(7, "0"));
}

export function balanceStroops(
  account: Awaited<ReturnType<typeof loadAccount>>,
  asset: Asset,
): bigint {
  const line = account.balances.find((b) =>
    asset.isNative()
      ? b.asset_type === "native"
      : "asset_code" in b &&
        b.asset_code === asset.code &&
        b.asset_issuer === asset.issuer,
  );
  return line ? toStroops(line.balance) : 0n;
}

export async function txRecord(hash: string) {
  return horizon.transactions().transaction(hash).call();
}

export async function feeCharged(hash: string): Promise<bigint> {
  return BigInt((await txRecord(hash)).fee_charged);
}

export async function claimableBalance(id: string) {
  try {
    return await horizon.claimableBalances().claimableBalance(id).call();
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/**
 * Unix time at which the seller's NOT(BEFORE_RELATIVE_TIME) claimant opens.
 * Horizon reports the relative window already resolved against the creating
 * ledger's close time.
 */
export async function reclaimOpensAt(balanceId: string, seller: string) {
  const cb = await claimableBalance(balanceId);
  const epoch = cb?.claimants.find((c) => c.destination === seller)?.predicate
    .not?.abs_before_epoch;
  if (!epoch) throw new Error(`No seller reclaim time on balance ${balanceId}`);
  return Number(epoch);
}

export async function latestLedger() {
  const { records } = await horizon.ledgers().order("desc").limit(1).call();
  return records[0];
}

/** Blocks until the network's latest closed ledger is at or past `epoch`. */
export async function waitForLedgerTime(epoch: number) {
  for (;;) {
    const closed = Date.parse((await latestLedger()).closed_at) / 1000;
    if (closed >= epoch) return;
    const ms = Math.max(1, epoch - closed) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(ms, 5_000)));
  }
}
