import { Asset, Keypair, type Horizon } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { ASSETS, ASSET_CODES, TESTNET_USDC_ISSUER, isLineOf, issuerOf, needsTrustline, toAsset } from "./assets";

const native = { asset_type: "native", balance: "10.0000000" } as unknown as Horizon.HorizonApi.BalanceLine;
const line = (code: string, issuer: string) =>
  ({ asset_type: "credit_alphanum4", asset_code: code, asset_issuer: issuer, balance: "1.0000000" }) as unknown as Horizon.HorizonApi.BalanceLine;

describe("the asset registry", () => {
  it("has one entry per code, each naming itself", () => {
    expect(Object.keys(ASSETS)).toEqual([...ASSET_CODES]);
    for (const code of ASSET_CODES) expect(ASSETS[code].code).toBe(code);
  });

  it("lists the codes in registry order, the third asset last (O-20)", () => {
    expect(ASSET_CODES).toEqual(["XLM", "USDC", "EURC"]);
  });

  it("knows XLM as native and USDC and EURC as Circle's testnet issues", () => {
    expect(issuerOf("XLM")).toBeNull();
    expect(issuerOf("USDC")).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    expect(issuerOf("EURC")).toBe("GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO");
    expect(TESTNET_USDC_ISSUER).toBe(ASSETS.USDC.issuer);
    expect(ASSETS.EURC.label).toBe("EURC");
  });

  it("keeps protected mode to USDC this month", () => {
    expect(ASSET_CODES.filter((c) => ASSETS[c].protectedMode)).toEqual(["USDC"]);
  });
});

describe("toAsset", () => {
  it("builds the SDK asset each code stands for", () => {
    expect(toAsset("XLM").isNative()).toBe(true);
    expect(toAsset("USDC").equals(new Asset("USDC", ASSETS.USDC.issuer!))).toBe(true);
    expect(toAsset("EURC").equals(new Asset("EURC", ASSETS.EURC.issuer!))).toBe(true);
  });

  it("gives EURC its own issuer, not USDC's", () => {
    expect(toAsset("EURC").getIssuer()).toBe(ASSETS.EURC.issuer);
    expect(toAsset("EURC").getIssuer()).not.toBe(ASSETS.USDC.issuer);
  });
});

describe("needsTrustline", () => {
  it("is false for the native asset and true for every issued one", () => {
    expect(needsTrustline("XLM")).toBe(false);
    expect(needsTrustline("USDC")).toBe(true);
    expect(needsTrustline("EURC")).toBe(true);
  });
});

describe("isLineOf", () => {
  it("matches a balance line on code and issuer, never on code alone", () => {
    expect(isLineOf(line("USDC", ASSETS.USDC.issuer!), "USDC")).toBe(true);
    expect(isLineOf(line("USDC", Keypair.random().publicKey()), "USDC")).toBe(false);
    expect(isLineOf(line("USDX", ASSETS.USDC.issuer!), "USDC")).toBe(false);
  });

  it("tells EURC from a same-code line of another issuer, and from USDC", () => {
    expect(isLineOf(line("EURC", ASSETS.EURC.issuer!), "EURC")).toBe(true);
    expect(isLineOf(line("EURC", Keypair.random().publicKey()), "EURC")).toBe(false);
    expect(isLineOf(line("EURC", ASSETS.USDC.issuer!), "EURC")).toBe(false);
    expect(isLineOf(line("USDC", ASSETS.USDC.issuer!), "EURC")).toBe(false);
  });

  it("matches only the native line for XLM", () => {
    expect(isLineOf(native, "XLM")).toBe(true);
    expect(isLineOf(native, "USDC")).toBe(false);
    expect(isLineOf(line("XLM", Keypair.random().publicKey()), "XLM")).toBe(false);
  });
});
