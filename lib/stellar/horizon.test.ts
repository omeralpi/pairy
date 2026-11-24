import { Account, Asset, Keypair, type Horizon } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TESTNET_USDC_ISSUER } from "./assets";
import { balanceOf, hasTrustline, networkDeadline } from "./horizon";
import { buildLockTransaction } from "./settlement";
import { buildTrustlineTransaction } from "./trustline";

const real = 1_800_000_000; // the network's now, unix seconds

/** Horizon answering with its own Date header, while this device runs 10 minutes slow. */
function slowDevice() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime((real - 600) * 1000);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", date: new Date(real * 1000).toUTCString() },
      }),
    ),
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("networkDeadline", () => {
  it("counts from Horizon's clock, not a device clock 10 minutes slow", async () => {
    slowDevice();
    expect(await networkDeadline(300)).toBe(real + 300);
  });

  it("gives a lock and a trustline a maxTime the network has not passed yet", async () => {
    slowDevice();
    const seller = Keypair.random().publicKey();
    const lock = buildLockTransaction(
      new Account(seller, "1"),
      { asset: Asset.native(), amount: "10", buyer: Keypair.random().publicKey() },
      await networkDeadline(300),
    );
    const trust = buildTrustlineTransaction(new Account(seller, "1"), "USDC", await networkDeadline(300));
    // With setTimeout(300) on this device's clock both would end at real - 300:
    // already past on the network, so every send was refused as tx_too_late.
    expect(Number(lock.timeBounds!.maxTime)).toBe(real + 300);
    expect(Number(trust.timeBounds!.maxTime)).toBe(real + 300);
  });
});

describe("hasTrustline and balanceOf", () => {
  const holding = (code: string, issuer: string, balance: string) =>
    ({
      balances: [
        { asset_type: "native", balance: "10.0000000" },
        { asset_type: "credit_alphanum4", asset_code: code, asset_issuer: issuer, balance },
      ],
    }) as unknown as Horizon.AccountResponse;

  it("refuse a same-code line from another issuer", () => {
    const lookalike = holding("USDC", Keypair.random().publicKey(), "100.0000000");
    expect(hasTrustline(lookalike, "USDC")).toBe(false);
    expect(balanceOf(lookalike, "USDC")).toBe("0");

    const real = holding("USDC", TESTNET_USDC_ISSUER, "100.0000000");
    expect(hasTrustline(real, "USDC")).toBe(true);
    expect(balanceOf(real, "USDC")).toBe("100.0000000");
    expect(hasTrustline(real, "XLM")).toBe(true);
    expect(balanceOf(real, "XLM")).toBe("10.0000000");
  });
});
