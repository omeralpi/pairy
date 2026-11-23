import { Asset } from "@stellar/stellar-sdk";

/** Circle's testnet USDC issuer (home_domain centre.io). */
export const TESTNET_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/**
 * Circle's testnet EURC issuer (home_domain circle.com; developers.circle.com,
 * "EURC on test networks"). Used by the treasury and evidence scripts until
 * WP-16's registry carries it; not an AssetCode yet.
 */
export const TESTNET_EURC_ISSUER =
  "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";

export const ASSET_CODES = ["XLM", "USDC"] as const;
export type AssetCode = (typeof ASSET_CODES)[number];

export function toAsset(code: AssetCode): Asset {
  return code === "XLM" ? Asset.native() : new Asset("USDC", TESTNET_USDC_ISSUER);
}

/** Non-native assets need a trustline on the claimant before they can claim. */
export function needsTrustline(code: AssetCode): boolean {
  return code !== "XLM";
}
