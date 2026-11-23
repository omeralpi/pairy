import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { PLATFORM_ACCOUNT } from "./config";

describe("escrow config", () => {
  it("pins the platform account as a Stellar public key", () => {
    expect(StrKey.isValidEd25519PublicKey(PLATFORM_ACCOUNT)).toBe(true);
  });
});
