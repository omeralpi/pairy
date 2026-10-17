import { Account, Asset, Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { networkDeadline } from "./horizon";
import { buildLockTransaction } from "./settlement";
import { buildUsdcTrustlineTransaction } from "./trustline";

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
    const trust = buildUsdcTrustlineTransaction(new Account(seller, "1"), await networkDeadline(300));
    // With setTimeout(300) on this device's clock both would end at real - 300:
    // already past on the network, so every send was refused as tx_too_late.
    expect(Number(lock.timeBounds!.maxTime)).toBe(real + 300);
    expect(Number(trust.timeBounds!.maxTime)).toBe(real + 300);
  });
});
