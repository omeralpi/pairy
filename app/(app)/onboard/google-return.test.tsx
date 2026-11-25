import { Keypair } from "@stellar/stellar-sdk";
import { useContext, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDeviceWallet } from "@/lib/wallet/device-wallet";
import { PRIVY_LOGIN_CLOSED, PrivyAdapterContext, type PrivyAdapter, type PrivyAdapterSlot } from "@/lib/wallet/privy-adapter";

// FIX-oauth2: the owner's live run on pairy.org, end to end in one test. The
// real WalletProvider and the real /onboard page, with the real resume mark in
// this tab's sessionStorage and a real device key in localStorage; Privy is a
// fake adapter. The App ID is read when the provider's module loads, so it is
// set before the imports below. Every other test runs without it, so there
// connectPrivy and resumePrivy are null and this wiring never ran.
vi.hoisted(() => vi.stubEnv("NEXT_PUBLIC_PRIVY_APP_ID", "test-app-id"));

// A small stand-in for React's commit loop, so the provider and the page can be
// clicked and re-rendered as a browser does: each mounted component keeps its
// state and refs across renders, a state change asks for a render, and after a
// render the effects whose dependencies changed run, the page's before the
// provider's (children first, as React runs them), with their cleanups.
type Instance = { store: unknown[]; effects: Map<number, { deps?: unknown[]; cleanup?: () => void }>; queue: (() => void)[]; i: number };
const hooks = vi.hoisted(() => ({ current: null as Instance | null, dirty: false }));
vi.mock("react", async (importOriginal) => {
  const React = await importOriginal<typeof import("react")>();
  // React's own, for the components this test does not mount by hand (the mock below is not a component).
  const reactState = React.useState;
  const reactRef = React.useRef;
  const reactEffect = React.useEffect;
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, k) => Object.is(x, b[k]));
  return {
    ...React,
    useState: (init: unknown) => {
      const h = hooks.current;
      if (!h) return reactState(init);
      const i = h.i++;
      if (!(i in h.store)) h.store[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        const next = typeof v === "function" ? (v as (old: unknown) => unknown)(h.store[i]) : v;
        if (Object.is(next, h.store[i])) return;
        h.store[i] = next;
        hooks.dirty = true;
      };
      return [h.store[i], set];
    },
    useRef: (init: unknown) => {
      const h = hooks.current;
      if (!h) return reactRef(init);
      const i = h.i++;
      if (!(i in h.store)) h.store[i] = { current: init };
      return h.store[i];
    },
    useEffect: (fn: () => unknown, deps?: unknown[]) => {
      const h = hooks.current;
      if (!h) return reactEffect(fn as () => void, deps);
      const i = h.i++;
      if (h.effects.has(i) && same(h.effects.get(i)!.deps, deps)) return;
      h.queue.push(() => {
        h.effects.get(i)?.cleanup?.();
        const cleanup = fn();
        h.effects.set(i, { deps, cleanup: typeof cleanup === "function" ? (cleanup as () => void) : undefined });
      });
    },
  };
});

// Pairy's Sign in dialog ("Confirm with Privy") as the provider opens it; the pincode dialog renders nothing.
const ui = vi.hoisted(() => ({ signIn: { open: false, title: "", summary: undefined as string | undefined } }));
vi.mock("@/components/wallet/sign-confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/wallet/sign-confirm-dialog")>()),
  SignConfirmDialog: ({ open, title, summary }: { open: boolean; title: string; summary?: string }) => {
    ui.signIn = { open, title, summary };
    return null;
  },
}));
vi.mock("@/components/wallet/pincode-dialog", () => ({ PincodeDialog: () => null }));
vi.mock("@/lib/wallet/freighter", () => ({
  connectFreighter: async () => "GVARIAL",
  disconnectFreighter: async () => {},
  signMessageWithFreighter: async () => "c2lnbmF0dXJl",
  signTransactionWithFreighter: async (_address: string, xdr: string) => xdr,
}));
// The Privy wallet is already on testnet (GC2T…4CQP was funded the evening before).
vi.mock("@/lib/stellar/horizon", () => ({ loadAccount: async () => ({}), fundWithFriendbot: async () => {} }));

// Not signed in to Pairy ("Sign in" at the top right). The SEP-53 login goes
// through the provider's signMessage, so a Privy wallet opens Pairy's dialog.
const MESSAGE = "Sign in to Pairy (Stellar testnet).\nNonce: abc";
const router = vi.hoisted(() => ({ push: vi.fn((_path: string) => {}) }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => ({ publicKey: null, loading: false }) }));
vi.mock("@/lib/auth/use-login", async () => {
  const { useWalletContext } = await import("@/lib/wallet/use-wallet");
  type Wallet = import("@/lib/wallet/use-wallet").Wallet;
  return {
    useLogin: () => {
      const { signMessage } = useWalletContext();
      return { login: async (wallet: Wallet, pincode?: string) => void (await signMessage(wallet, MESSAGE, pincode)), logout: async () => {}, pending: false };
    },
  };
});

const { WalletProvider } = await import("@/components/providers/wallet-provider");
const { default: OnboardPage } = await import("./page");

/** The Web Storage API in memory: the tab's sessionStorage and the browser's localStorage, which outlive a page load. */
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

const MARK = "pairy:privy-connect";
const PIN = "correct horse";
const kp = Keypair.random();
const PRIVY_WALLET = kp.publicKey();

type ChoiceProps = { note?: string; title: string; disabled: boolean; onClick: () => void };
/** A choice on the page, from the elements it rendered (their click handlers included). */
function findChoice(node: ReactNode, match: (props: ChoiceProps) => boolean): ChoiceProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findChoice(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const props = (node as ReactElement).props as ChoiceProps & { children?: ReactNode };
  if (typeof props.onClick === "function" && typeof props.title === "string" && match(props)) return props;
  return findChoice(props.children, match);
}

/** Privy as PrivyLayer hands it to the provider, recording what Pairy asks of it. */
function privy(calls: string[], state: { ready: boolean; authenticated: boolean; address?: string; login?: () => Promise<void> }): PrivyAdapter {
  return {
    ready: state.ready,
    authenticated: state.authenticated,
    loginLabel: state.authenticated ? "Google" : null,
    login: state.login ?? (async () => void calls.push("login")),
    logout: async () => void calls.push("logout"),
    stellarAddress: () => state.address ?? null,
    createStellarWallet: async () => {
      calls.push("create");
      return PRIVY_WALLET;
    },
    signRawHash: async (_address, hash32) => {
      calls.push("sign");
      return new Uint8Array(kp.sign(Buffer.from(hash32)));
    },
    exportKey: async () => {},
  };
}

/** One page load of /onboard under the (app) layout's WalletProvider. */
function load() {
  const instance = (): Instance => ({ store: [], effects: new Map(), queue: [], i: 0 });
  const app = { provider: instance(), page: instance(), slot: null as PrivyAdapterSlot | null, tree: null as ReactNode };
  ui.signIn = { open: false, title: "", summary: undefined };
  const host = <T,>(h: Instance, fn: () => T): T => {
    hooks.current = h;
    h.i = 0;
    try {
      return fn();
    } finally {
      hooks.current = null;
    }
  };
  const ProviderHost = ({ children }: { children: ReactNode }) => host(app.provider, () => WalletProvider({ children }));
  const SlotProbe = () => {
    app.slot = useContext(PrivyAdapterContext);
    return null;
  };
  const PageHost = () => host(app.page, () => (app.tree = OnboardPage()));
  const render = () => {
    hooks.dirty = false;
    renderToStaticMarkup(
      <ProviderHost>
        <SlotProbe />
        <PageHost />
      </ProviderHost>,
    );
    for (const run of [...app.page.queue.splice(0), ...app.provider.queue.splice(0)]) run();
  };
  /** Renders again for as long as a state change asks for it. */
  const flush = () => {
    for (let n = 0; hooks.dirty && n < 50; n++) render();
  };
  render();
  const privyChoice = () => findChoice(app.tree, (c) => c.note === "New here? Start here");
  return {
    /** PrivyLayer's effect: hands the provider Privy's current state. */
    setPrivy: (adapter: PrivyAdapter) => app.slot!.setAdapter(adapter),
    privyChoice,
    /** What the owner sees: Pairy's Sign in dialog, and the Privy choice on the picker. */
    seen: () => ({
      signInDialog: ui.signIn.open ? ui.signIn.title : null,
      privyChoice: privyChoice()?.title ?? null,
      choicesDisabled: privyChoice()?.disabled ?? null,
    }),
    until: (check: () => void, timeout = 10_000) =>
      vi.waitFor(
        () => {
          flush();
          check();
        },
        { timeout, interval: 5 },
      ),
    /** Lets async work and the renders it asks for run out. */
    quiet: async () => {
      for (let n = 0; n < 10; n++) {
        flush();
        await new Promise((r) => setTimeout(r, 5));
      }
      flush();
    },
    /** The page goes away (Google's redirect): effects are cleaned up; only the two storages are left. */
    unload: () => {
      for (const h of [app.page, app.provider]) for (const e of h.effects.values()) e.cleanup?.();
    },
  };
}

describe("back from Google's login on pairy.org, as the owner ran it (FIX-oauth2)", () => {
  let tab: MemoryStorage;
  let browser: MemoryStorage;
  beforeEach(() => {
    tab = new MemoryStorage();
    browser = new MemoryStorage();
    vi.stubGlobal("sessionStorage", tab);
    vi.stubGlobal("localStorage", browser);
    vi.stubGlobal("window", { location: { search: "", origin: "https://pairy.org" } });
    router.push.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    hooks.current = null;
  });
  afterAll(() => vi.unstubAllEnvs());

  /** On /onboard, Privy ready and logged out: the user clicks "Continue with email or Google" and Privy's modal opens. */
  async function clickPrivy(page: ReturnType<typeof load>, calls: string[], login: () => Promise<void>) {
    page.setPrivy(privy(calls, { ready: true, authenticated: false, login }));
    await page.until(() => expect(page.privyChoice()?.title).toBe("Continue with email or Google"));
    page.privyChoice()!.onClick();
  }
  /** Privy's modal, then Google: the browser leaves for Google's account chooser, so this login never settles here. */
  const google = (calls: string[]) => () => (calls.push("login"), new Promise<void>(() => {}));

  it("the page that opened Privy's login keeps the mark while it re-renders, until Google takes the page away", async () => {
    const calls: string[] = [];
    const page = load();
    await clickPrivy(page, calls, google(calls));
    await page.until(() => expect(calls).toEqual(["login"]));
    // React renders the page again while Privy's modal is open: the click changed its state.
    await page.quiet();
    expect(page.seen()).toEqual({ signInDialog: null, privyChoice: "Opening Privy…", choicesDisabled: true });
    expect(tab.getItem(MARK)).toBe("1");
    page.unload();
  });

  it.each([
    ["logged out first, so no wallet is selected", (_device: string) => null],
    ["the key on this device selected (Phase 1)", (device: string) => ({ kind: "device", publicKey: device })],
    ["a Varial (formerly Freighter) account selected", (_device: string) => ({ kind: "freighter", publicKey: "GVARIAL" })],
  ])("a key already on this device, %s: back from Google, Pairy's Sign in dialog opens with no second click", async (_state, selected) => {
    // ALREADY ON THIS PHONE: a device key from Phase 1, and whatever wallet this browser last selected.
    const device = await createDeviceWallet(PIN, browser);
    const selection = selected(device);
    if (selection) browser.setItem("pairy:wallet", JSON.stringify(selection));
    const calls: string[] = [];

    const before = load();
    await clickPrivy(before, calls, google(calls));
    await before.until(() => expect(calls).toEqual(["login"]));
    await before.quiet();
    before.unload();

    // Back on /onboard, a new page load. Privy finishes the OAuth by itself: its chunk loads, it
    // verifies the code with Google ("Successfully connected with Google"), and turns ready logged in.
    const after = load();
    await after.quiet();
    after.setPrivy(privy(calls, { ready: false, authenticated: false }));
    await after.quiet();
    after.setPrivy(privy(calls, { ready: true, authenticated: true, address: PRIVY_WALLET }));
    // The owner saw no dialog and the picker still offering "Continue with email or Google".
    await after.until(
      () => expect(after.seen()).toEqual({ signInDialog: "Sign in", privyChoice: "Continue with email or Google", choicesDisabled: true }),
      3_000,
    );
    expect(ui.signIn.summary).toBe(MESSAGE);
    expect(JSON.parse(browser.getItem("pairy:wallet")!)).toEqual({ kind: "privy", publicKey: PRIVY_WALLET });
    expect(tab.getItem(MARK)).toBeNull();
    // No second Privy login, no new wallet, and nothing signed until the user presses Sign (DECISIONS 12).
    expect(calls).toEqual(["login"]);
    expect(router.push).not.toHaveBeenCalled();
    after.unload();
  });

  it("closing Privy's modal on that page leaves nothing to carry on: a later visit with a Privy session opens no dialog", async () => {
    const calls: string[] = [];
    let close: (() => void) | null = null;
    const page = load();
    await clickPrivy(page, calls, () => new Promise<void>((_, reject) => (close = () => reject(new Error(PRIVY_LOGIN_CLOSED)))));
    await page.until(() => expect(close).not.toBeNull());
    await page.quiet();
    close!();
    await page.quiet();
    expect(tab.getItem(MARK)).toBeNull();
    expect(page.seen()).toEqual({ signInDialog: null, privyChoice: "Continue with email or Google", choicesDisabled: false });
    page.unload();

    const later = load();
    later.setPrivy(privy(calls, { ready: true, authenticated: true, address: PRIVY_WALLET }));
    await later.until(() => expect(later.privyChoice()?.title).toBe("Continue with email or Google"));
    await later.quiet();
    expect(later.seen()).toEqual({ signInDialog: null, privyChoice: "Continue with email or Google", choicesDisabled: false });
    expect(browser.getItem("pairy:wallet")).toBeNull();
    later.unload();
  });
});
