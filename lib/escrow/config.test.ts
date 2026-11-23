import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { ARBITER_ACCOUNT, PLATFORM_ACCOUNT } from "./config";

describe("escrow config", () => {
  it("pins the platform account as a Stellar public key", () => {
    expect(StrKey.isValidEd25519PublicKey(PLATFORM_ACCOUNT)).toBe(true);
  });

  it("pins the arbiter account as a Stellar public key that is not the platform account", () => {
    expect(StrKey.isValidEd25519PublicKey(ARBITER_ACCOUNT)).toBe(true);
    expect(ARBITER_ACCOUNT).not.toBe(PLATFORM_ACCOUNT);
  });
});
