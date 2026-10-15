import { Asset } from "@stellar/stellar-sdk";

/** Circle's testnet USDC issuer (home_domain centre.io). */
export const TESTNET_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const ASSET_CODES = ["XLM", "USDC"] as const;
export type AssetCode = (typeof ASSET_CODES)[number];

export function toAsset(code: AssetCode): Asset {
  return code === "XLM" ? Asset.native() : new Asset("USDC", TESTNET_USDC_ISSUER);
}

/** Non-native assets need a trustline on the claimant before they can claim. */
export function needsTrustline(code: AssetCode): boolean {
  return code !== "XLM";
}
