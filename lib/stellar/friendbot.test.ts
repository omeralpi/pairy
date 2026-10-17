import { afterEach, describe, expect, it, vi } from "vitest";

import { fundWithFriendbot } from "./horizon";

describe("fundWithFriendbot (Q-6)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says Friendbot is down and points at Stellar Lab instead of echoing the raw body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"type":"https://stellar.org/horizon-errors/server_error","status":500}', { status: 500 })),
    );
    const err = await fundWithFriendbot("GABC").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^Friendbot, the testnet faucet, didn't fund this account \(HTTP 500\)/);
    expect((err as Error).message).toMatch(/Stellar Lab/);
    expect((err as Error).message).not.toMatch(/horizon-errors/);
  });

  it("gives the same advice when Friendbot cannot be reached at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fundWithFriendbot("GABC")).rejects.toThrow(/didn't fund this account\. It is sometimes down/);
  });
});
