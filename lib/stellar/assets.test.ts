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

  it("knows XLM as native and USDC as Circle's testnet issue", () => {
    expect(issuerOf("XLM")).toBeNull();
    expect(issuerOf("USDC")).toBe("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    expect(TESTNET_USDC_ISSUER).toBe(ASSETS.USDC.issuer);
  });

  it("keeps protected mode to USDC this month", () => {
    expect(ASSET_CODES.filter((c) => ASSETS[c].protectedMode)).toEqual(["USDC"]);
  });
});

describe("toAsset", () => {
  it("builds the SDK asset each code stands for", () => {
    expect(toAsset("XLM").isNative()).toBe(true);
    expect(toAsset("USDC").equals(new Asset("USDC", ASSETS.USDC.issuer!))).toBe(true);
  });
});

describe("needsTrustline", () => {
  it("is false for the native asset and true for every issued one", () => {
    expect(needsTrustline("XLM")).toBe(false);
    expect(needsTrustline("USDC")).toBe(true);
  });
});

describe("isLineOf", () => {
  it("matches a balance line on code and issuer, never on code alone", () => {
    expect(isLineOf(line("USDC", ASSETS.USDC.issuer!), "USDC")).toBe(true);
    expect(isLineOf(line("USDC", Keypair.random().publicKey()), "USDC")).toBe(false);
    expect(isLineOf(line("USDX", ASSETS.USDC.issuer!), "USDC")).toBe(false);
  });

  it("matches only the native line for XLM", () => {
    expect(isLineOf(native, "XLM")).toBe(true);
    expect(isLineOf(native, "USDC")).toBe(false);
    expect(isLineOf(line("XLM", Keypair.random().publicKey()), "XLM")).toBe(false);
  });
});
