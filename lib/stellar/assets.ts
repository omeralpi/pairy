import { Asset, type Horizon } from "@stellar/stellar-sdk";

/** A literal tuple: pgEnum and z.enum need one. */
export const ASSET_CODES = ["XLM", "USDC", "EURC"] as const;
export type AssetCode = (typeof ASSET_CODES)[number];
/** The codes with an issuer: everything but native XLM. */
export type IssuedCode = Exclude<AssetCode, "XLM">;

export type AssetInfo = {
  code: AssetCode;
  /** null = native XLM. */
  issuer: string | null;
  /** Shown in the UI. */
  label: string;
  /** Shown in Proof / EVIDENCE. */
  issuerNote: string;
  /** D2: the protected (escrow) trade path; USDC only this month. */
  protectedMode: boolean;
};

/** Everything Pairy knows about each asset it trades. */
export const ASSETS = {
  XLM: {
    code: "XLM",
    issuer: null,
    label: "XLM",
    issuerNote: "Stellar's native asset",
    protectedMode: false,
  },
  USDC: {
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    label: "USDC",
    issuerNote: "Circle's testnet issuer, home domain centre.io",
    protectedMode: true,
  },
  EURC: {
    code: "EURC",
    issuer: "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO",
    label: "EURC",
    issuerNote: "Circle's testnet issuer, home domain circle.com, all auth flags off (checked 2026-11-23)",
    protectedMode: false,
  },
} satisfies { readonly [K in AssetCode]: AssetInfo };

/** Circle's testnet USDC issuer (home_domain centre.io); the same as ASSETS.USDC.issuer. */
export const TESTNET_USDC_ISSUER: string = ASSETS.USDC.issuer;

export function issuerOf(code: AssetCode): string | null {
  return ASSETS[code].issuer;
}

export function toAsset(code: AssetCode): Asset {
  const issuer = issuerOf(code);
  return issuer === null ? Asset.native() : new Asset(code, issuer);
}

/** Non-native assets need a trustline on the claimant before they can claim. */
export function needsTrustline(code: AssetCode): code is IssuedCode {
  return issuerOf(code) !== null;
}

/** A Horizon balance line belongs to this asset: code AND issuer. The one predicate every balance search uses. */
export function isLineOf(line: Horizon.HorizonApi.BalanceLine, code: AssetCode): boolean {
  const issuer = issuerOf(code);
  if (issuer === null) return line.asset_type === "native";
  return "asset_code" in line && line.asset_code === code && line.asset_issuer === issuer;
}
