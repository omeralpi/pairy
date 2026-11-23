import { Networks, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { toAsset } from "@/lib/stellar/assets";

import { ARBITER_ACCOUNT, PLATFORM_ACCOUNT, USDC_SAC } from "./config";

describe("escrow config", () => {
  it("pins the platform account as a Stellar public key", () => {
    expect(StrKey.isValidEd25519PublicKey(PLATFORM_ACCOUNT)).toBe(true);
  });

  it("pins the arbiter account as a Stellar public key that is not the platform account", () => {
    expect(StrKey.isValidEd25519PublicKey(ARBITER_ACCOUNT)).toBe(true);
    expect(ARBITER_ACCOUNT).not.toBe(PLATFORM_ACCOUNT);
  });

  it("pins USDC_SAC as the contract of Circle's testnet USDC", () => {
    expect(USDC_SAC).toBe(toAsset("USDC").contractId(Networks.TESTNET));
  });
});
