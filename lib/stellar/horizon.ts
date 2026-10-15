// Read and submit against Stellar testnet. Pairy never signs here: callers
// pass in transactions already signed by the user's own wallet.

import { Horizon, NotFoundError, type Transaction } from "@stellar/stellar-sdk";

import { TESTNET_USDC_ISSUER, type AssetCode } from "./assets";

export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

export const horizon = new Horizon.Server(HORIZON_URL);

/** null when the account does not exist on the network yet. */
export async function loadAccount(publicKey: string) {
  try {
    return await horizon.loadAccount(publicKey);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}

/** Creates and funds a new testnet account. Pairy never funds accounts itself. */
export async function fundWithFriendbot(publicKey: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) {
    throw new Error(`Friendbot failed (${res.status}): ${await res.text()}`);
  }
}

export function hasTrustline(
  account: Horizon.AccountResponse,
  code: AssetCode,
): boolean {
  if (code === "XLM") return true;
  return account.balances.some(
    (b) =>
      "asset_code" in b &&
      b.asset_code === code &&
      b.asset_issuer === TESTNET_USDC_ISSUER,
  );
}

export function balanceOf(account: Horizon.AccountResponse, code: AssetCode): string {
  const line = account.balances.find((b) =>
    code === "XLM"
      ? b.asset_type === "native"
      : "asset_code" in b && b.asset_code === code && b.asset_issuer === TESTNET_USDC_ISSUER,
  );
  return line?.balance ?? "0";
}

export async function submit(tx: Transaction) {
  return horizon.submitTransaction(tx);
}

export function explorerTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

export function explorerAccountUrl(publicKey: string): string {
  return `https://stellar.expert/explorer/testnet/account/${publicKey}`;
}
