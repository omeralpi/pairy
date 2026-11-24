import { Networks, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { toAsset } from "@/lib/stellar/assets";
import type { WalletKind } from "@/lib/wallet/use-wallet";

import {
  ARBITER_ACCOUNT,
  PLATFORM_ACCOUNT,
  PROTECTED_WALLET_KINDS,
  SERVICE_PROVIDER_ROLE,
  TW_ESCROW_WASM_HASH,
  TW_FACTORY_CONTRACT_ID,
  TW_FEE_ADDRESS,
  USDC_SAC,
  twViewerUrl,
} from "./config";

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

  // Each equals what the Gate D2 release recorded on testnet, so an edit cannot quietly un-pin one:
  // while a pin is null, lib/escrow/xdr.ts does not check that part of the call (FIXES F-02, F-10).
  it("pins Trustless Work's factory, escrow code and fee address to the values recorded on testnet", () => {
    expect(TW_FACTORY_CONTRACT_ID).toBe("CCYOZX2IZBMFWN5MIMGQ7GAND7KSAIRCEC3LQSUS5CTSJ6SKKTTYL7GL");
    expect(TW_ESCROW_WASM_HASH).toBe("1231807d01111bee78a846ddacdd0a6cf88b762115e70f5bce16ffabd660e47f");
    expect(TW_FEE_ADDRESS).toBe("GDDL743M3SOW6GN4HOAKU5ACA7QN36ERFBXNHY5BS7HOR2DPOSGMRCYF");
    expect(StrKey.isValidContract(TW_FACTORY_CONTRACT_ID ?? "")).toBe(true);
    expect(StrKey.isValidEd25519PublicKey(TW_FEE_ADDRESS ?? "")).toBe(true);
    expect([ARBITER_ACCOUNT, PLATFORM_ACCOUNT]).not.toContain(TW_FEE_ADDRESS);
  });

  it("keeps the seller as the service provider: the seller alone released on testnet (S-16)", () => {
    expect(SERVICE_PROVIDER_ROLE).toBe("seller");
  });

  // S-06 (WP-20): a Privy wallet signed a Trustless Work fund and release on testnet, so "privy" stays.
  it("allows every wallet kind in protected mode, Privy included (S-06)", () => {
    const kinds: readonly WalletKind[] = PROTECTED_WALLET_KINDS;
    expect([...kinds].sort()).toEqual(["device", "freighter", "privy"]);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("links an escrow to Trustless Work's testnet viewer", () => {
    expect(twViewerUrl("CCGML7GRKDX42ZYSSXSQYXU7Q5HQ3A6O2SZZPLOYVJY6CROAJHVRYAUN")).toBe(
      "https://viewer.trustlesswork.com/testnet/v2/CCGML7GRKDX42ZYSSXSQYXU7Q5HQ3A6O2SZZPLOYVJY6CROAJHVRYAUN",
    );
  });
});
