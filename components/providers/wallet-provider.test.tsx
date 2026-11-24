import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PrivyAdapter } from "@/lib/wallet/privy-adapter";

// The Privy branch of the provider as plain functions over a fake adapter: no
// browser, no Privy. Horizon is stubbed so Friendbot and loadAccount are seen.
const horizon = vi.hoisted(() => ({
  loadAccount: vi.fn(async (_publicKey: string): Promise<unknown> => ({})),
  fundWithFriendbot: vi.fn(async (_publicKey: string) => {}),
}));
vi.mock("@/lib/stellar/horizon", () => horizon);

const { connectPrivyWallet, ensurePrivy, restoredSelection } = await import("./wallet-provider");

/** A Privy adapter whose login lands on `address`, recording every call. */
function fakeAdapter(over: Partial<PrivyAdapter> & { address?: string | null; addressAfterLogin?: string | null } = {}) {
  const calls: string[] = [];
  let address = over.address ?? null;
  const adapter: PrivyAdapter = {
    ready: true,
    authenticated: true,
    loginLabel: "a…@example.com",
    login: async () => {
      calls.push("login");
      if ("addressAfterLogin" in over) address = over.addressAfterLogin ?? null;
    },
    logout: async () => {
      calls.push("logout");
    },
    stellarAddress: () => address,
    createStellarWallet: async () => {
      calls.push("create");
      address = "GNEW";
      return address;
    },
    signRawHash: async () => new Uint8Array(64),
    exportKey: async () => {},
    ...over,
  };
  return { adapter, calls };
}

const saved = { kind: "privy", publicKey: "GPRIVY" } as const;

describe("restoredSelection (F-18)", () => {
  it("keeps a saved Privy selection but is not ready until Privy's chunk has loaded and Privy is ready", () => {
    expect(restoredSelection(saved, null, { enabled: true, adapter: null })).toEqual({ selection: saved, ready: false });
    const { adapter } = fakeAdapter({ ready: false, authenticated: false });
    expect(restoredSelection(saved, null, { enabled: true, adapter })).toEqual({ selection: saved, ready: false });
  });

  it("is ready once Privy is, keeping the selection for an unauthenticated session or the same address", () => {
    const loggedOut = fakeAdapter({ authenticated: false }).adapter;
    expect(restoredSelection(saved, null, { enabled: true, adapter: loggedOut })).toEqual({ selection: saved, ready: true });
    const same = fakeAdapter({ address: "GPRIVY" }).adapter;
    expect(restoredSelection(saved, null, { enabled: true, adapter: same })).toEqual({ selection: saved, ready: true });
  });

  it("clears the selection when Privy is authenticated as a different Stellar address", () => {
    const other = fakeAdapter({ address: "GOTHER" }).adapter;
    expect(restoredSelection(saved, null, { enabled: true, adapter: other })).toEqual({ selection: null, ready: true });
  });

  it("drops a saved Privy selection when the build has no App ID", () => {
    expect(restoredSelection(saved, null, { enabled: false, adapter: null })).toEqual({ selection: null, ready: true });
  });

  it("restores device and Freighter selections as before, whatever Privy is doing", () => {
    const privy = { enabled: true, adapter: null };
    const freighter = { kind: "freighter", publicKey: "GFREIGHTER" } as const;
    const device = { kind: "device", publicKey: "GDEVICE" } as const;
    expect(restoredSelection(freighter, null, privy)).toEqual({ selection: freighter, ready: true });
    expect(restoredSelection(device, "GDEVICE", privy)).toEqual({ selection: device, ready: true });
    expect(restoredSelection(device, "GSOMEONEELSE", privy)).toEqual({ selection: null, ready: true });
    expect(restoredSelection(device, null, privy)).toEqual({ selection: null, ready: true });
    expect(restoredSelection(null, "GDEVICE", privy)).toEqual({ selection: null, ready: true });
  });
});

describe("ensurePrivy: the re-login before a signature", () => {
  it("logs in again when the Privy session is gone and the same address comes back", async () => {
    const { adapter, calls } = fakeAdapter({ authenticated: false, address: null, addressAfterLogin: "GPRIVY" });
    expect(await ensurePrivy(adapter, "GPRIVY")).toBe(adapter);
    expect(calls).toEqual(["login"]);
  });

  it("does not open the login when the session is still there", async () => {
    const { adapter, calls } = fakeAdapter({ address: "GPRIVY" });
    await ensurePrivy(adapter, "GPRIVY");
    expect(calls).toEqual([]);
  });

  it("rejects when the login lands on a different account than this wallet", async () => {
    const { adapter } = fakeAdapter({ authenticated: false, address: null, addressAfterLogin: "GOTHER" });
    await expect(ensurePrivy(adapter, "GPRIVY")).rejects.toThrow(
      "You signed in to Privy with a different account than this wallet. Use the same email or Google account.",
    );
  });

  it("rejects while Privy's chunk has not loaded yet", async () => {
    await expect(ensurePrivy(null, "GPRIVY")).rejects.toThrow(/still loading/);
  });
});

describe("connectPrivyWallet", () => {
  beforeEach(() => {
    horizon.loadAccount.mockReset().mockResolvedValue({});
    horizon.fundWithFriendbot.mockReset().mockResolvedValue(undefined);
  });

  it("second browser: reuses the Stellar wallet Privy already holds and never calls createWallet", async () => {
    const { adapter, calls } = fakeAdapter({ authenticated: false, address: null, addressAfterLogin: "GEXISTING" });
    expect(await connectPrivyWallet(adapter)).toBe("GEXISTING");
    expect(calls).toEqual(["login"]);
    expect(horizon.fundWithFriendbot).not.toHaveBeenCalled();
  });

  it("first browser: creates the wallet and asks Friendbot once because the account is missing (DECISIONS 9)", async () => {
    horizon.loadAccount.mockResolvedValue(null);
    const { adapter, calls } = fakeAdapter({ address: null });
    expect(await connectPrivyWallet(adapter)).toBe("GNEW");
    expect(calls).toEqual(["create"]);
    expect(horizon.loadAccount).toHaveBeenCalledWith("GNEW");
    expect(horizon.fundWithFriendbot).toHaveBeenCalledTimes(1);
    expect(horizon.fundWithFriendbot).toHaveBeenCalledWith("GNEW");
  });

  it("continues when Friendbot fails: the wallet page offers the manual button", async () => {
    horizon.loadAccount.mockResolvedValue(null);
    horizon.fundWithFriendbot.mockRejectedValue(new Error("Friendbot, the testnet faucet, didn't fund this account (HTTP 503)."));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { adapter } = fakeAdapter({ address: null });
    expect(await connectPrivyWallet(adapter)).toBe("GNEW");
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("rejects while Privy's chunk has not loaded yet", async () => {
    await expect(connectPrivyWallet(null)).rejects.toThrow(/still loading/);
  });
});
