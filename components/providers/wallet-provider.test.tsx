import { Account, Keypair, Networks, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRIVY_LOGIN_TEXT } from "@/components/wallet/sign-confirm-dialog";
import { buildClaimTransaction } from "@/lib/stellar/settlement";
import { createDeviceWallet } from "@/lib/wallet/device-wallet";
import { PRIVY_LOGIN_CLOSED, type PrivyAdapter } from "@/lib/wallet/privy-adapter";
import { useWalletContext, type WalletContextValue } from "@/lib/wallet/use-wallet";

// The Privy branch of the provider as plain functions over a fake adapter and
// a fake prompt: no browser, no Privy. Horizon is stubbed so Friendbot and
// loadAccount are seen.
const horizon = vi.hoisted(() => ({
  loadAccount: vi.fn(async (_publicKey: string): Promise<unknown> => ({})),
  fundWithFriendbot: vi.fn(async (_publicKey: string) => {}),
}));
vi.mock("@/lib/stellar/horizon", () => horizon);

// WalletProvider itself, mounted by hand for the FIX-oauth round-1 tests: with
// `on`, useState keeps its values across renders, as a mounted provider does,
// and useEffect is captured so its mount effect can be run. The dialogs render
// nothing and Varial (Freighter) is a stub; the device wallet is the real one.
const hooks = vi.hoisted(() => ({ on: false, store: [] as unknown[], i: 0, effects: [] as (() => unknown)[] }));
vi.mock("react", async (importOriginal) => {
  const React = await importOriginal<typeof import("react")>();
  // React's own, for every render outside the mounted-provider tests (the mock below is not a component).
  const reactState = React.useState;
  return {
    ...React,
    useState: (init: unknown) => {
      if (!hooks.on) return reactState(init);
      const i = hooks.i++;
      if (!(i in hooks.store)) hooks.store[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        hooks.store[i] = typeof v === "function" ? (v as (old: unknown) => unknown)(hooks.store[i]) : v;
      };
      return [hooks.store[i], set];
    },
    useEffect: (fn: () => unknown) => void hooks.effects.push(fn),
  };
});
vi.mock("@/components/wallet/pincode-dialog", () => ({ PincodeDialog: () => null }));
vi.mock("@/components/wallet/sign-confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/wallet/sign-confirm-dialog")>()),
  SignConfirmDialog: () => null,
}));
const varial = vi.hoisted(() => ({ disconnectFreighter: vi.fn(async () => {}) }));
vi.mock("@/lib/wallet/freighter", () => ({
  connectFreighter: async () => "GFREIGHTER",
  disconnectFreighter: varial.disconnectFreighter,
  signMessageWithFreighter: async () => "c2lnbmF0dXJl",
  signTransactionWithFreighter: async (_address: string, xdr: string) => xdr,
}));

const {
  PRIVY_BAD_SIGNATURE,
  PRIVY_DOWN,
  PRIVY_LOADING,
  PRIVY_OTHER_ACCOUNT,
  WalletProvider,
  connectPrivyWallet,
  createPrompt,
  ensurePrivy,
  logoutPrivy,
  privySignMessage,
  privySignTransaction,
  restoredSelection,
  resumesPrivyConnect,
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

/** The "a Privy connect left this page for its login" mark as the provider keeps it in sessionStorage, in memory here. */
function fakePending(initial = false) {
  let flag = initial;
  return { pending: () => flag, mark: () => void (flag = true), clear: () => void (flag = false) };
}

describe("back from Google's login, which leaves the page (FIX-oauth)", () => {
  beforeEach(() => {
    horizon.loadAccount.mockReset().mockResolvedValue({});
    horizon.fundWithFriendbot.mockReset().mockResolvedValue(undefined);
  });
  const message = "Sign in to Pairy (Stellar testnet).\nNonce: abc";

  it("marks the connect while Privy's login is open: a login that leaves the page keeps the mark, one that settles here clears it", async () => {
    // Google: Privy's modal sends the browser to Google, so this login never settles on this page.
    let opened!: () => void;
    const loginOpened = new Promise<void>((r) => (opened = r));
    const left = fakePending();
    const google = fakeAdapter({ authenticated: false, login: () => (opened(), new Promise<void>(() => {})) });
    void connectPrivyWallet(google.state, () => {}, fakeOwed(), left);
    await loginOpened;
    expect(left.pending()).toBe(true);

    // Email: the code is typed in Privy's modal and the login settles here.
    const email = fakePending();
    let markedDuringLogin = false;
    const typed = fakeAdapter({ authenticated: false, address: "GEMAIL", login: async () => void (markedDuringLogin = email.pending()) });
    expect(await connectPrivyWallet(typed.state, () => {}, fakeOwed(), email)).toBe("GEMAIL");
    expect(markedDuringLogin).toBe(true);
    expect(email.pending()).toBe(false);

    // Closed: the user shut Privy's modal.
    const closed = fakePending();
    const shut = fakeAdapter({ authenticated: false, login: async () => Promise.reject(new Error(PRIVY_LOGIN_CLOSED)) });
    await expect(connectPrivyWallet(shut.state, () => {}, fakeOwed(), closed)).rejects.toThrow(PRIVY_LOGIN_CLOSED);
    expect(closed.pending()).toBe(false);
  });

  it("back logged in with no Stellar wallet yet: carries on with no click, creates and funds it, and stops at Pairy's Sign in dialog", async () => {
    horizon.loadAccount.mockResolvedValue(null);
    const { calls, state } = fakeAdapter({ address: null });
    const left = fakePending(true);
    expect(resumesPrivyConnect(state, left, fakeOwed())).toBe(true);
    const publicKey = await connectPrivyWallet(state, () => {}, fakeOwed(), left);
    expect(publicKey).toBe("GNEW");
    expect(calls).toEqual(["create"]);
    expect(horizon.fundWithFriendbot).toHaveBeenCalledWith("GNEW");
    // Already logged in, the carried-on connect marks nothing: no second resume after this one.
    expect(left.pending()).toBe(false);

    const dialog = fakePrompt();
    void privySignMessage(state, publicKey, message, dialog.prompt).catch(() => {});
    await dialog.opened;
    expect(dialog.asked).toEqual([{ title: "Sign in", description: PRIVY_LOGIN_TEXT, summary: message }]);
    // Nothing is signed until the user presses Sign (DECISIONS 12).
    expect(calls).toEqual(["create"]);
    dialog.cancel();
  });

  it("back logged in with the Stellar wallet Privy already holds: finds it, opens no second Privy login, and stops at the same dialog", async () => {
    const { calls, state } = fakeAdapter({ address: kp.publicKey() });
    const left = fakePending(true);
    expect(resumesPrivyConnect(state, left, fakeOwed())).toBe(true);
    expect(await connectPrivyWallet(state, () => {}, fakeOwed(), left)).toBe(kp.publicKey());
    expect(left.pending()).toBe(false);

    const dialog = fakePrompt();
    const signing = privySignMessage(state, kp.publicKey(), message, dialog.prompt);
    await dialog.opened;
    expect(calls).toEqual([]);
    await dialog.sign();
    expect(kp.verifyMessage(message, Buffer.from(await signing, "base64"))).toBe(true);
    expect(calls).toEqual(["sign"]);
  });

  it("a connect already logged in to Privy marks nothing, so a cancelled Sign in dialog is not carried on again", async () => {
    const { calls, state } = fakeAdapter({ address: kp.publicKey() });
    const fresh = fakePending();
    expect(await connectPrivyWallet(state, () => {}, fakeOwed(), fresh)).toBe(kp.publicKey());
    expect(fresh.pending()).toBe(false);

    const dialog = fakePrompt();
    const signing = privySignMessage(state, kp.publicKey(), message, dialog.prompt);
    await dialog.opened;
    dialog.cancel();
    await expect(signing).rejects.toThrow("Signing cancelled.");
    // The render after Cancel asks again: nothing to carry on, so the dialog does not come back.
    expect(resumesPrivyConnect(state, fresh, fakeOwed())).toBe(false);
    expect(calls).toEqual([]);
  });

  it("waits while Privy is still loading, keeping the mark, then says yes once", () => {
    const left = fakePending(true);
    expect(resumesPrivyConnect({ adapter: null, failed: false }, left, fakeOwed())).toBe(false);
    expect(resumesPrivyConnect(fakeAdapter({ ready: false, authenticated: false }).state, left, fakeOwed())).toBe(false);
    // Slower than the F-18 bound: counted as failed for now; a Privy that turns up ready is used after all.
    expect(resumesPrivyConnect({ adapter: null, failed: true }, left, fakeOwed())).toBe(false);
    expect(left.pending()).toBe(true);

    const { state } = fakeAdapter({ address: null });
    expect(resumesPrivyConnect(state, left, fakeOwed())).toBe(true);
    // Decided: a re-render, a reload or a cancelled Sign in dialog does not start it again.
    expect(left.pending()).toBe(false);
    expect(resumesPrivyConnect(state, left, fakeOwed())).toBe(false);
  });

  it("does not carry on when Privy came back logged out, a logout is owed, or no connect was started in this tab", () => {
    // Google failed, or the user closed Privy's modal on the way back: decided, and back to the choices.
    const loggedOut = fakePending(true);
    expect(resumesPrivyConnect(fakeAdapter({ authenticated: false }).state, loggedOut, fakeOwed())).toBe(false);
    expect(loggedOut.pending()).toBe(false);

    // A logout made while Privy was down (R2-1): the provider ends that session; the user is not signed back in.
    const owed = fakeOwed(true);
    const out = fakePending(true);
    expect(resumesPrivyConnect(fakeAdapter({ address: "GPRIVY" }).state, out, owed)).toBe(false);
    expect(out.pending()).toBe(false);
    expect(owed.owed()).toBe(true);

    // A Privy session left from an earlier visit (a device key or Freighter chosen since): nothing to carry on.
    expect(resumesPrivyConnect(fakeAdapter({ address: "GPRIVY" }).state, fakePending(), fakeOwed())).toBe(false);
  });
});

/** The Web Storage API in memory: sessionStorage for the mark, localStorage for the selection and the device key. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.items.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.items.set(k, String(v));
  }
  removeItem(k: string) {
    this.items.delete(k);
  }
  clear() {
    this.items.clear();
  }
}

describe("the resume mark in this tab's storage, and what ends it (FIX-oauth round 1)", () => {
  const MARK = "pairy:privy-connect";
  const PIN = "correct horse";
  const message = "Sign in to Pairy (Stellar testnet).\nNonce: abc";
  let tab: MemoryStorage;
  let browser: MemoryStorage;
  beforeEach(() => {
    tab = new MemoryStorage();
    browser = new MemoryStorage();
    vi.stubGlobal("sessionStorage", tab);
    vi.stubGlobal("localStorage", browser);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    hooks.on = false;
  });

  /** Google's login left the page: the connect marked this tab and never settled here. */
  async function leftForGoogle() {
    let opened!: () => void;
    const loginOpened = new Promise<void>((r) => (opened = r));
    const google = fakeAdapter({ authenticated: false, login: () => (opened(), new Promise<void>(() => {})) });
    void connectPrivyWallet(google.state);
    await loginOpened;
    expect(tab.getItem(MARK)).toBe("1");
  }
  /** Would the onboarding carry the connect on, with Privy ready and logged in? Stored mark, stored owed logout. */
  const resumes = () => resumesPrivyConnect(fakeAdapter({ address: "GPRIVY" }).state);

  /** WalletProvider as a page under it sees it, mounted by hand: state kept across renders, its mount effect run. */
  async function mountProvider() {
    Object.assign(hooks, { on: true, store: [], i: 0 });
    let ctx!: WalletContextValue;
    const Probe = () => {
      ctx = useWalletContext();
      return null;
    };
    const render = () => {
      hooks.i = 0;
      hooks.effects.length = 0;
      renderToStaticMarkup(
        <WalletProvider>
          <Probe />
        </WalletProvider>,
      );
      return ctx;
    };
    render();
    for (const effect of hooks.effects.splice(0)) effect();
    await vi.waitFor(() => expect(render().ready).toBe(true), { timeout: 10_000 });
    return render;
  }

  it("lives in sessionStorage: kept while Privy loads, spent once Privy is ready", async () => {
    await leftForGoogle();
    expect(resumesPrivyConnect({ adapter: null, failed: false })).toBe(false);
    expect(tab.getItem(MARK)).toBe("1");
    expect(resumes()).toBe(true);
    expect(tab.getItem(MARK)).toBeNull();
    expect(resumes()).toBe(false);
  });

  // Back from Google, the user leaves the choice before Privy is ready there (it was slow, or they went
  // elsewhere). Whatever they pick instead ends it: a later /onboard visit, Privy logged in, carries nothing on.
  async function afterGoogle(act: (ctx: WalletContextValue) => unknown) {
    await leftForGoogle();
    const render = await mountProvider();
    await act(render());
    expect(tab.getItem(MARK)).toBeNull();
    expect(resumes()).toBe(false);
  }
  const varialWallet = { kind: "freighter" as const, publicKey: "GFREIGHTER", signTransaction: async (xdr: string) => xdr };

  it("ends when a key is made on this device", () => afterGoogle((ctx) => ctx.createDeviceWallet(PIN)));

  it("ends when the key already stored here is picked", async () => {
    await createDeviceWallet(PIN, browser);
    await afterGoogle((ctx) => ctx.selectDeviceWallet());
  });

  it("ends when Varial (formerly Freighter) is connected", () => afterGoogle((ctx) => ctx.connectFreighter()));

  it("ends when the user signs in with the wallet already selected here (Sign in again)", () =>
    afterGoogle((ctx) => ctx.signMessage(varialWallet, message)));

  it("ends when the user logs out", () => afterGoogle((ctx) => ctx.disconnect()));

  it("ends when the user logs out, even if Varial's disconnect fails before the wallet is forgotten", async () => {
    browser.setItem("pairy:wallet", JSON.stringify({ kind: "freighter", publicKey: "GFREIGHTER" }));
    varial.disconnectFreighter.mockRejectedValueOnce(new Error("Varial didn't answer."));
    await afterGoogle(async (ctx) => {
      expect(ctx.wallet?.kind).toBe("freighter");
      await expect(ctx.disconnect()).rejects.toThrow("Varial didn't answer.");
    });
  });
});
