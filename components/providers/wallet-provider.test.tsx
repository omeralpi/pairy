import { Account, Keypair, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PRIVY_LOGIN_TEXT } from "@/components/wallet/sign-confirm-dialog";
import { buildClaimTransaction } from "@/lib/stellar/settlement";
import type { PrivyAdapter } from "@/lib/wallet/privy-adapter";

// The Privy branch of the provider as plain functions over a fake adapter and
// a fake prompt: no browser, no Privy. Horizon is stubbed so Friendbot and
// loadAccount are seen.
const horizon = vi.hoisted(() => ({
  loadAccount: vi.fn(async (_publicKey: string): Promise<unknown> => ({})),
  fundWithFriendbot: vi.fn(async (_publicKey: string) => {}),
}));
vi.mock("@/lib/stellar/horizon", () => horizon);

const {
  PRIVY_BAD_SIGNATURE,
  PRIVY_DOWN,
  PRIVY_LOADING,
  PRIVY_OTHER_ACCOUNT,
  connectPrivyWallet,
  createPrompt,
  ensurePrivy,
  logoutPrivy,
  privySignMessage,
  privySignTransaction,
  restoredSelection,
} = await import("./wallet-provider");
type ConfirmPrompt = Parameters<typeof privySignMessage>[3];
type PromptRequest = Parameters<Parameters<typeof createPrompt>[1]>[0];

const kp = Keypair.random();

/** A Privy adapter whose login lands on `address`, signing with `key`, recording every call. */
function fakeAdapter(
  over: Partial<PrivyAdapter> & { address?: string | null; addressAfterLogin?: string | null; key?: Keypair } = {},
) {
  const calls: string[] = [];
  let address = over.address ?? null;
  const key = over.key ?? kp;
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
    signRawHash: async (_address, hash32) => {
      calls.push("sign");
      return new Uint8Array(key.sign(Buffer.from(hash32)));
    },
    exportKey: async () => {},
    ...over,
  };
  return { adapter, calls, state: { adapter, failed: false } };
}

/** The "a Privy logout is owed" flag as the provider keeps it in storage, in memory here. */
function fakeOwed(initial = false) {
  let flag = initial;
  return { owed: () => flag, owe: () => void (flag = true), clear: () => void (flag = false) };
}

/** Pairy's dialog as the signing paths see it: records what it is asked, runs `fn` only on sign(). */
function fakePrompt() {
  const asked: { title: string; description: string; summary?: string; signal?: AbortSignal }[] = [];
  let pending: { fn: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void } | null = null;
  let open!: () => void;
  // Resolves once the dialog has been asked (the signing paths load their
  // helpers first); a path that signs without asking fails here, fast.
  const opened = Promise.race([
    new Promise<void>((r) => (open = r)),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Pairy's dialog was never opened.")), 2000)),
  ]);
  const prompt: ConfirmPrompt = (title, description, fn, opts) =>
    new Promise((resolve, reject) => {
      asked.push({ title, description, summary: opts?.summary, signal: opts?.signal });
      pending = { fn, resolve: resolve as (v: unknown) => void, reject };
      open();
    });
  return {
    prompt,
    asked,
    opened,
    sign: async () => {
      try {
        pending!.resolve(await pending!.fn());
      } catch (e) {
        pending!.reject(e);
      }
    },
    cancel: () => pending!.reject(new Error("Signing cancelled.")),
  };
}

const saved = { kind: "privy", publicKey: "GPRIVY" } as const;
const enabled = { enabled: true, failed: false };

describe("restoredSelection (F-18)", () => {
  it("keeps a saved Privy selection but is not ready until Privy's chunk has loaded and Privy is ready", () => {
    expect(restoredSelection(saved, null, { ...enabled, adapter: null })).toEqual({ selection: saved, ready: false });
    const { adapter } = fakeAdapter({ ready: false, authenticated: false });
    expect(restoredSelection(saved, null, { ...enabled, adapter })).toEqual({ selection: saved, ready: false });
  });

  it("is ready once Privy is, keeping the selection for an unauthenticated session or the same address", () => {
    const loggedOut = fakeAdapter({ authenticated: false }).adapter;
    expect(restoredSelection(saved, null, { ...enabled, adapter: loggedOut })).toEqual({ selection: saved, ready: true });
    const same = fakeAdapter({ address: "GPRIVY" }).adapter;
    expect(restoredSelection(saved, null, { ...enabled, adapter: same })).toEqual({ selection: saved, ready: true });
  });

  it("clears the selection when Privy is authenticated as a different Stellar address", () => {
    const other = fakeAdapter({ address: "GOTHER" }).adapter;
    expect(restoredSelection(saved, null, { ...enabled, adapter: other })).toEqual({ selection: null, ready: true });
  });

  it("drops a saved Privy selection when the build has no App ID", () => {
    expect(restoredSelection(saved, null, { enabled: false, failed: false, adapter: null })).toEqual({ selection: null, ready: true });
  });

  it("is ready with the selection kept when Privy failed to load or did not answer in time", () => {
    expect(restoredSelection(saved, null, { enabled: true, failed: true, adapter: null })).toEqual({ selection: saved, ready: true });
    const { adapter } = fakeAdapter({ ready: false, authenticated: false });
    expect(restoredSelection(saved, null, { enabled: true, failed: true, adapter })).toEqual({ selection: saved, ready: true });
  });

  it("restores device and Freighter selections as before, whatever Privy is doing", () => {
    const privy = { ...enabled, adapter: null };
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
    const { adapter, calls, state } = fakeAdapter({ authenticated: false, address: null, addressAfterLogin: "GPRIVY" });
    expect(await ensurePrivy(state, "GPRIVY")).toBe(adapter);
    expect(calls).toEqual(["login"]);
  });

  it("does not open the login when the session is still there", async () => {
    const { calls, state } = fakeAdapter({ address: "GPRIVY" });
    await ensurePrivy(state, "GPRIVY");
    expect(calls).toEqual([]);
  });

  it("rejects when the login lands on a different account than this wallet", async () => {
    const { state } = fakeAdapter({ authenticated: false, address: null, addressAfterLogin: "GOTHER" });
    await expect(ensurePrivy(state, "GPRIVY")).rejects.toThrow(PRIVY_OTHER_ACCOUNT);
  });

  it("rejects, without opening Privy's login, while Privy's chunk or Privy itself is not ready yet", async () => {
    await expect(ensurePrivy({ adapter: null, failed: false }, "GPRIVY")).rejects.toThrow(PRIVY_LOADING);
    const { calls, state } = fakeAdapter({ ready: false, authenticated: false });
    await expect(ensurePrivy(state, "GPRIVY")).rejects.toThrow(PRIVY_LOADING);
    expect(calls).toEqual([]);
  });

  it("says Privy isn't answering when it failed to load, with the device-key way out", async () => {
    await expect(ensurePrivy({ adapter: null, failed: true }, "GPRIVY")).rejects.toThrow(PRIVY_DOWN);
    expect(PRIVY_DOWN).toBe("Privy isn't answering. Try again, or make a key on this device.");
  });
});

describe("connectPrivyWallet", () => {
  beforeEach(() => {
    horizon.loadAccount.mockReset().mockResolvedValue({});
    horizon.fundWithFriendbot.mockReset().mockResolvedValue(undefined);
  });

  it("second browser: reuses the Stellar wallet Privy already holds and never calls createWallet", async () => {
    const { calls, state } = fakeAdapter({ authenticated: false, address: null, addressAfterLogin: "GEXISTING" });
    expect(await connectPrivyWallet(state)).toBe("GEXISTING");
    expect(calls).toEqual(["login"]);
    expect(horizon.fundWithFriendbot).not.toHaveBeenCalled();
  });

  it("first browser: creates the wallet and asks Friendbot once because the account is missing (DECISIONS 9)", async () => {
    horizon.loadAccount.mockResolvedValue(null);
    const { calls, state } = fakeAdapter({ address: null });
    expect(await connectPrivyWallet(state)).toBe("GNEW");
    expect(calls).toEqual(["create"]);
    expect(horizon.loadAccount).toHaveBeenCalledWith("GNEW");
    expect(horizon.fundWithFriendbot).toHaveBeenCalledTimes(1);
    expect(horizon.fundWithFriendbot).toHaveBeenCalledWith("GNEW");
  });

  it("continues when Friendbot fails: the wallet page offers the manual button", async () => {
    horizon.loadAccount.mockResolvedValue(null);
    horizon.fundWithFriendbot.mockRejectedValue(new Error("Friendbot, the testnet faucet, didn't fund this account (HTTP 503)."));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { state } = fakeAdapter({ address: null });
    expect(await connectPrivyWallet(state)).toBe("GNEW");
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("rejects before Privy is ready, and says Privy isn't answering once it failed", async () => {
    await expect(connectPrivyWallet({ adapter: null, failed: false })).rejects.toThrow(PRIVY_LOADING);
    const { calls, state } = fakeAdapter({ ready: false, authenticated: false });
    await expect(connectPrivyWallet(state)).rejects.toThrow(PRIVY_LOADING);
    expect(calls).toEqual([]);
    await expect(connectPrivyWallet({ adapter: null, failed: true })).rejects.toThrow(PRIVY_DOWN);
  });

  it("reports each slow step as it starts, and null once the wallet is connected, so the onboarding button says only what it is waiting for", async () => {
    horizon.loadAccount.mockResolvedValue(null);
    const steps: (string | null)[] = [];
    const first = fakeAdapter({ authenticated: false, address: null, addressAfterLogin: null });
    await connectPrivyWallet(first.state, (step) => steps.push(step));
    expect(steps).toEqual(["login", "creating", "funding", null]);
    // Friendbot failing ends the funding step too: the label must not say it is still being asked.
    horizon.fundWithFriendbot.mockRejectedValue(new Error("HTTP 503"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed: (string | null)[] = [];
    await connectPrivyWallet(fakeAdapter({ address: null }).state, (step) => failed.push(step));
    expect(failed).toEqual(["creating", "funding", null]);
    logged.mockRestore();
    // Second browser, funded account, session still there: nothing slow happens.
    horizon.loadAccount.mockResolvedValue({});
    horizon.fundWithFriendbot.mockResolvedValue(undefined);
    const again: (string | null)[] = [];
    await connectPrivyWallet(fakeAdapter({ address: "GEXISTING" }).state, (step) => again.push(step));
    expect(again).toEqual([null]);
  });
});

describe("privySignTransaction: Pairy's dialog before every Privy signature (DECISIONS 12)", () => {
  const xdr = () => buildClaimTransaction(new Account(kp.publicKey(), "1"), `00000000${"ab".repeat(32)}`).toXDR();

  it("asks the dialog first, describes the transaction, and hands Privy the hash only on Sign", async () => {
    const { calls, state } = fakeAdapter({ address: kp.publicKey() });
    const dialog = fakePrompt();
    // Built once: the claim transaction's time bounds come from the clock.
    const unsigned = xdr();
    const signing = privySignTransaction(state, kp.publicKey(), unsigned, undefined, dialog.prompt);
    await dialog.opened;
    expect(calls).toEqual([]);
    expect(dialog.asked).toEqual([
      { title: "Sign transaction", description: expect.stringContaining("hash"), summary: "Claim the locked balance 00000000abab…abab" },
    ]);

    await dialog.sign();
    const signedXdr = await signing;
    expect(calls).toEqual(["sign"]);
    expect((TransactionBuilder.fromXDR(signedXdr, Networks.TESTNET) as Transaction).signatures).toHaveLength(1);
    // ed25519 is deterministic: the SDK's own signing with the same key gives the same envelope.
    const expected = TransactionBuilder.fromXDR(unsigned, Networks.TESTNET) as Transaction;
    expected.sign(kp);
    expect(signedXdr).toBe(expected.toXDR());
  });

  it("shows the caller's summary when it gives one, and passes the abort signal on", async () => {
    const { state } = fakeAdapter({ address: kp.publicKey() });
    const dialog = fakePrompt();
    const controller = new AbortController();
    void privySignTransaction(state, kp.publicKey(), xdr(), { summary: "Lock 25 USDC for GABC…WXYZ", signal: controller.signal }, dialog.prompt).catch(
      () => {},
    );
    await dialog.opened;
    expect(dialog.asked[0].summary).toBe("Lock 25 USDC for GABC…WXYZ");
    // The dialog gets the caller's signal, so a screen going away closes it.
    expect(dialog.asked[0].signal).toBe(controller.signal);
  });

  it("never calls Privy when the dialog is cancelled", async () => {
    const { calls, state } = fakeAdapter({ address: kp.publicKey() });
    const dialog = fakePrompt();
    const signing = privySignTransaction(state, kp.publicKey(), xdr(), undefined, dialog.prompt);
    await dialog.opened;
    dialog.cancel();
    await expect(signing).rejects.toThrow("Signing cancelled.");
    expect(calls).toEqual([]);
  });

  it("refuses a Privy signature that does not match the transaction, in the dialog's words, so nothing is sent", async () => {
    const { state } = fakeAdapter({ address: kp.publicKey(), key: Keypair.random() });
    const dialog = fakePrompt();
    const signing = privySignTransaction(state, kp.publicKey(), xdr(), undefined, dialog.prompt);
    await dialog.opened;
    await dialog.sign();
    await expect(signing).rejects.toThrow(PRIVY_BAD_SIGNATURE);
    expect(PRIVY_BAD_SIGNATURE).toBe("Privy returned a signature that does not match this transaction. Nothing was sent.");
  });

  it("rejects a re-login that lands on another account before any dialog opens", async () => {
    const { calls, state } = fakeAdapter({ authenticated: false, address: null, addressAfterLogin: "GOTHER" });
    const dialog = fakePrompt();
    await expect(privySignTransaction(state, kp.publicKey(), xdr(), undefined, dialog.prompt)).rejects.toThrow(PRIVY_OTHER_ACCOUNT);
    expect(dialog.asked).toEqual([]);
    expect(calls).toEqual(["login"]);
  });
});

describe("privySignMessage: the SEP-53 login through the same dialog", () => {
  const message = "Sign in to Pairy (Stellar testnet).\nNonce: abc";

  it("asks with the title Sign in, DECISIONS 12's line and the challenge text, and signs only on Sign", async () => {
    const { calls, state } = fakeAdapter({ address: kp.publicKey() });
    const dialog = fakePrompt();
    const signing = privySignMessage(state, kp.publicKey(), message, dialog.prompt);
    await dialog.opened;
    expect(calls).toEqual([]);
    expect(dialog.asked).toEqual([{ title: "Sign in", description: PRIVY_LOGIN_TEXT, summary: message }]);
    expect(PRIVY_LOGIN_TEXT).toBe("Sign in: this signs a message and moves no funds");

    await dialog.sign();
    const signature = await signing;
    expect(calls).toEqual(["sign"]);
    expect(kp.verifyMessage(message, Buffer.from(signature, "base64"))).toBe(true);
  });

  it("never calls Privy when the dialog is cancelled", async () => {
    const { calls, state } = fakeAdapter({ address: kp.publicKey() });
    const dialog = fakePrompt();
    const signing = privySignMessage(state, kp.publicKey(), message, dialog.prompt);
    await dialog.opened;
    dialog.cancel();
    await expect(signing).rejects.toThrow("Signing cancelled.");
    expect(calls).toEqual([]);
  });
});

describe("createPrompt: what Sign and Cancel do with a request", () => {
  function harness() {
    const requests: (PromptRequest | null)[] = [];
    const busy = { current: false };
    const prompt = createPrompt(busy, (r) => requests.push(r));
    const open = () => requests[requests.length - 1]!;
    return { prompt, requests, busy, open };
  }

  it("Sign runs the signing function and closes the dialog with its result", async () => {
    const { prompt, requests, open, busy } = harness();
    const fn = vi.fn(async () => "signed-xdr");
    const result = prompt("confirm", "Sign transaction", "text", fn, { summary: "Lock 1 XLM" });
    expect(open()).toMatchObject({ kind: "confirm", title: "Sign transaction", description: "text", summary: "Lock 1 XLM" });
    expect(fn).not.toHaveBeenCalled();
    expect(busy.current).toBe(true);
    await open().run("");
    expect(await result).toBe("signed-xdr");
    expect(fn).toHaveBeenCalledOnce();
    expect(requests.at(-1)).toBeNull();
    expect(busy.current).toBe(false);
  });

  it("Cancel never runs the signing function and rejects with Signing cancelled.", async () => {
    const { prompt, requests, open, busy } = harness();
    const fn = vi.fn(async () => "signed-xdr");
    const result = prompt("confirm", "Sign in", "text", fn);
    open().cancel();
    await expect(result).rejects.toThrow("Signing cancelled.");
    expect(fn).not.toHaveBeenCalled();
    expect(requests.at(-1)).toBeNull();
    expect(busy.current).toBe(false);
  });

  it("a Privy error keeps the confirm dialog open for a retry, and the retry can succeed", async () => {
    const { prompt, requests, open } = harness();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Privy returned a signature that does not match this transaction. Nothing was sent."))
      .mockResolvedValueOnce("signed-xdr");
    const result = prompt("confirm", "Sign transaction", "text", fn);
    await expect(open().run("")).rejects.toThrow(/does not match/);
    expect(requests.at(-1)).not.toBeNull(); // still open: the dialog shows the error
    await open().run("");
    expect(await result).toBe("signed-xdr");
  });

  it("every request has its own id, so the dialog keyed on it mounts fresh and no earlier error carries over", async () => {
    const { prompt, open } = harness();
    const first = prompt("confirm", "a", "b", async () => "x");
    const firstId = open().id;
    open().cancel();
    await expect(first).rejects.toThrow("Signing cancelled.");
    const second = prompt("confirm", "a", "b", async () => "y");
    expect(open().id).not.toBe(firstId);
    open().cancel();
    await expect(second).rejects.toThrow("Signing cancelled.");
  });

  it("one request at a time, and an aborted screen closes the open one before it can sign", async () => {
    const { prompt, requests, open } = harness();
    const controller = new AbortController();
    const fn = vi.fn(async () => "x");
    const first = prompt("confirm", "a", "b", fn, { signal: controller.signal });
    await expect(prompt("confirm", "a", "b", fn)).rejects.toThrow("Another signing request is already open.");
    controller.abort();
    await expect(first).rejects.toThrow("Signing cancelled.");
    expect(requests.at(-1)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(open).toBeDefined();
  });
});

describe("a Privy logout owed from a logout made while Privy was down (R2-1)", () => {
  beforeEach(() => {
    horizon.loadAccount.mockReset().mockResolvedValue({});
    horizon.fundWithFriendbot.mockReset().mockResolvedValue(undefined);
  });

  it("logoutPrivy logs out of Privy when it is ready, so the session does not outlive the wallet", async () => {
    const { calls, state } = fakeAdapter({ address: "GPRIVY" });
    const owed = fakeOwed();
    await logoutPrivy(state.adapter, owed);
    expect(calls).toEqual(["logout"]);
    expect(owed.owed()).toBe(false);
  });

  it("logoutPrivy records the debt instead when Privy is missing or not ready, and when its logout fails", async () => {
    const missing = fakeOwed();
    await logoutPrivy(null, missing);
    expect(missing.owed()).toBe(true);

    const { calls, state } = fakeAdapter({ ready: false });
    const notReady = fakeOwed();
    await logoutPrivy(state.adapter, notReady);
    expect(calls).toEqual([]);
    expect(notReady.owed()).toBe(true);

    const failing = fakeAdapter({ address: "GPRIVY", logout: async () => Promise.reject(new Error("Failed to fetch")) });
    const rejected = fakeOwed();
    await expect(logoutPrivy(failing.state.adapter, rejected)).rejects.toThrow("Failed to fetch");
    expect(rejected.owed()).toBe(true);
  });

  it("connectPrivyWallet pays the debt before reusing the session: logout, then Privy's login, then the flag is cleared", async () => {
    const { calls, state } = fakeAdapter({ address: "GOLD", addressAfterLogin: "GNEXT" });
    const owed = fakeOwed(true);
    const steps: (string | null)[] = [];
    expect(await connectPrivyWallet(state, (step) => steps.push(step), owed)).toBe("GNEXT");
    expect(calls).toEqual(["logout", "login"]);
    expect(steps).toEqual(["login", null]);
    expect(owed.owed()).toBe(false);
    // Paid: the next connect with the session Privy now holds is the second-browser path again.
    const again = fakeAdapter({ address: "GEXISTING" });
    expect(await connectPrivyWallet(again.state, () => {}, owed)).toBe("GEXISTING");
    expect(again.calls).toEqual([]);
  });

  it("clears a debt with nothing to pay when Privy already has no session", async () => {
    const { calls, state } = fakeAdapter({ authenticated: false, address: null, addressAfterLogin: "GNEXT" });
    const owed = fakeOwed(true);
    expect(await connectPrivyWallet(state, () => {}, owed)).toBe("GNEXT");
    expect(calls).toEqual(["login"]);
    expect(owed.owed()).toBe(false);
  });

  it("ensurePrivy pays the debt too, then asks for the login and checks the address as before", async () => {
    const { calls, state } = fakeAdapter({ address: "GPRIVY", addressAfterLogin: "GPRIVY" });
    const owed = fakeOwed(true);
    await ensurePrivy(state, "GPRIVY", owed);
    expect(calls).toEqual(["logout", "login"]);
    expect(owed.owed()).toBe(false);
    const other = fakeAdapter({ address: "GPRIVY", addressAfterLogin: "GOTHER" });
    await expect(ensurePrivy(other.state, "GPRIVY", fakeOwed(true))).rejects.toThrow(PRIVY_OTHER_ACCOUNT);
  });
});
