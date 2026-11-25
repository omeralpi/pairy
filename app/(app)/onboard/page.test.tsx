import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { FREIGHTER_MISSING } from "@/lib/wallet/freighter";

// The onboarding page as it renders for one wallet context; no browser, so
// effects do not run and the markup is enough to see which choices are offered
// and what the headline promises.
const ctx = vi.hoisted(() => ({ value: {} as Record<string, unknown>, session: null as string | null, sessionLoading: false }));
// An error to show as if a wallet step had failed: the page's null states
// start at it instead (only `error` is rendered on the choices screen).
const failed = vi.hoisted(() => ({ error: null as string | null }));
// React's useEffect is captured so a test can run the page's effects by hand, as a mount would.
const effects = vi.hoisted(() => [] as (() => void)[]);
const signedIn = vi.hoisted(() => ({ login: vi.fn(async (_wallet: unknown) => {}), push: vi.fn((_path: string) => {}) }));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (v: unknown) => react.useState(v === null ? failed.error : v),
    useEffect: (fn: () => void) => void effects.push(fn),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: signedIn.push }) }));
vi.mock("@/lib/auth/use-login", () => ({ useLogin: () => ({ login: signedIn.login, logout: async () => {}, pending: false }) }));
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => ({ publicKey: ctx.session, loading: ctx.sessionLoading }) }));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWalletContext: () => ctx.value }));

const { default: OnboardPage } = await import("./page");

const base = {
  wallet: null,
  ready: true,
  deviceWalletPublicKey: null,
  connectPrivy: null,
  exportPrivyKey: null,
  privy: { enabled: false, ready: false, failed: false, authenticated: false, loginLabel: null },
};
const withPrivy = {
  ...base,
  connectPrivy: async () => ({}),
  exportPrivyKey: async () => {},
  disconnect: async () => {},
  privy: { enabled: true, ready: true, failed: false, authenticated: false, loginLabel: null },
};
const privyDown = { ...withPrivy, privy: { ...withPrivy.privy, ready: false, failed: true } };
const PRIVY_DOWN = "Privy isn&#x27;t answering. Try again, or make a key on this device.";
const render = (value: Record<string, unknown>, session: string | null = null) => {
  ctx.value = value;
  ctx.session = session;
  return renderToStaticMarkup(<OnboardPage />);
};
const privyWallet = { kind: "privy", publicKey: "GPRIVY00000000000000000000000000000000000000000000000000", signTransaction: async () => "" };

describe("OnboardPage: the headline (G26)", () => {
  it("no longer promises that the key stays on this phone, which is false for a Privy wallet", () => {
    const html = render(base);
    expect(html).not.toContain("on this phone");
    expect(html).toMatch(/<h1[^>]*>Pick how <em[^>]*>you&#x27;ll sign\.<\/em><\/h1>/);
  });
});

describe("OnboardPage: the Privy choice", () => {
  it("is hidden without an App ID, and the device key stays the first step", () => {
    const html = render(base);
    expect(html).not.toContain("Continue with email or Google");
    expect(html).not.toContain("Privy");
    expect(html).toMatch(/New here\? Start here<\/span><span[^>]*>Make a key on this device/);
  });

  it("comes first with an App ID, with honest copy, and the device choice keeps its own promise", () => {
    const html = render(withPrivy);
    const privy = html.indexOf("Continue with email or Google");
    const device = html.indexOf("Make a key on this device");
    expect(privy).toBeGreaterThan(-1);
    expect(privy).toBeLessThan(device);
    expect(html).toMatch(/New here\? Start here<\/span><span[^>]*>Continue with email or Google/);
    expect(html).toContain(
      "A wallet is made for you and opens again wherever you sign in. Privy says it splits the key and holds it for you; Pairy never has it. Whoever controls that email or Google account controls this wallet.",
    );
    // How Privy holds the key is Privy's claim, which Pairy cannot check, so it is credited to Privy (O-44).
    expect(html).not.toContain("The key is split and held by Privy");
    // The headline's old promise now sits only on the choice it is true for.
    expect(html).toMatch(/Make a key on this device<\/span><span[^>]*>Your key stays on this device/);
    expect(html).not.toMatch(/New here\? Start here<\/span><span[^>]*>Make a key on this device/);
    expect(html).not.toContain('disabled=""');
  });

  it("reads Opening Privy… and is disabled until Privy is ready", () => {
    const html = render({ ...withPrivy, privy: { ...withPrivy.privy, ready: false } });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Opening Privy…/);
    expect(html).not.toContain("Continue with email or Google");
    // Only the Privy choice waits; the device key and Freighter are usable now.
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });

  it("says Privy isn't answering once it failed, and leaves every choice usable (D1 §7.1)", () => {
    const html = render(privyDown);
    expect(html).toMatch(new RegExp(`New here\\? Start here</span><span[^>]*>${PRIVY_DOWN}`));
    expect(html).not.toContain("Opening Privy…");
    expect(html).not.toContain("Continue with email or Google");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Make a key on this device");
  });
});

describe("OnboardPage: back from Google's login (FIX-oauth)", () => {
  // Google's login leaves the page, so the click that opened it is gone. Back
  // here, Privy is logged in and the provider says the connect should carry on.
  const mount = (value: Record<string, unknown>, session: string | null = null, sessionLoading = false) => {
    effects.length = 0;
    signedIn.login.mockClear();
    signedIn.push.mockClear();
    vi.stubGlobal("window", { location: { search: "", origin: "https://pairy.org" } });
    ctx.sessionLoading = sessionLoading;
    try {
      render(value, session);
    } finally {
      ctx.sessionLoading = false;
    }
    for (const effect of effects) effect();
  };
  const afterAsync = () => new Promise((r) => setTimeout(r, 0));

  it("carries the Privy connect on with no click, through the same sign-in, to the new wallet", async () => {
    const connectPrivy = vi.fn(async () => privyWallet);
    try {
      mount({ ...withPrivy, connectPrivy, resumePrivy: () => true });
      await afterAsync();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(connectPrivy).toHaveBeenCalledOnce();
    // login() is the SEP-53 sign-in: for a Privy wallet it opens Pairy's Sign in dialog first (DECISIONS 12).
    expect(signedIn.login).toHaveBeenCalledOnce();
    expect(signedIn.login).toHaveBeenCalledWith(privyWallet, undefined);
    expect(signedIn.push).toHaveBeenCalledWith("/wallet?new=1");
  });

  it("does nothing on its own when the provider says there is nothing to carry on", async () => {
    const connectPrivy = vi.fn(async () => privyWallet);
    try {
      mount({ ...withPrivy, connectPrivy, resumePrivy: () => false });
      await afterAsync();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(connectPrivy).not.toHaveBeenCalled();
    expect(signedIn.login).not.toHaveBeenCalled();
  });

  it("spends the mark but carries nothing on for a user already signed in, whatever their wallet (round 1)", async () => {
    for (const kind of ["device", "freighter", "privy"]) {
      const wallet = { ...privyWallet, kind };
      const connectPrivy = vi.fn(async () => privyWallet);
      const resumePrivy = vi.fn(() => true);
      try {
        mount({ ...withPrivy, wallet, connectPrivy, resumePrivy }, wallet.publicKey);
        await afterAsync();
      } finally {
        vi.unstubAllGlobals();
      }
      expect(resumePrivy, kind).toHaveBeenCalled();
      expect(connectPrivy, kind).not.toHaveBeenCalled();
      expect(signedIn.login, kind).not.toHaveBeenCalled();
    }
  });

  it("does not decide while the session is still loading, so a signed-in user is never taken for a new one (round 1)", async () => {
    const connectPrivy = vi.fn(async () => privyWallet);
    const resumePrivy = vi.fn(() => true);
    try {
      mount({ ...withPrivy, connectPrivy, resumePrivy }, null, true);
      await afterAsync();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(resumePrivy).not.toHaveBeenCalled();
    expect(connectPrivy).not.toHaveBeenCalled();
  });
});

describe("OnboardPage: the Freighter choice", () => {
  it("names the extension as it ships today, Varial (formerly Freighter), where a person must recognise it (O-30)", () => {
    const html = render(withPrivy);
    expect(html).toMatch(/Use Varial \(formerly Freighter\)<\/span><span[^>]*>For people who already have the Varial extension/);
    expect(html).not.toContain("Use Freighter");
  });

  it("sends a browser without the extension to varialwallet.com, naming it Varial (formerly Freighter) first (O-30)", () => {
    expect(FREIGHTER_MISSING.indexOf("Varial (formerly Freighter)")).toBe(0);
    failed.error = FREIGHTER_MISSING;
    try {
      const html = render(base);
      const link = html.match(/<a[^>]*href="([^"]*)"[^>]*>Get Varial ↗<\/a>/);
      expect(link, "no Get Varial ↗ link under the error").not.toBeNull();
      expect(new URL(link![1]).host).toBe("varialwallet.com");
      expect(html).not.toContain("freighter.app");
    } finally {
      failed.error = null;
    }
  });
});

describe("OnboardPage: the wallet kind label", () => {
  it("names a signed-in Privy wallet an email wallet, not a key on this device", () => {
    const html = render({ ...withPrivy, wallet: privyWallet }, privyWallet.publicKey);
    expect(html).toContain("You&#x27;re signed in.");
    expect(html).toContain("Email wallet (Privy)");
    expect(html).not.toContain("Key on this device");
  });

  it("says which wallet is connected but not signed in, and waits for Privy before offering to sign in", () => {
    const html = render({ ...withPrivy, wallet: privyWallet, privy: { ...withPrivy.privy, ready: false } });
    expect(html).toContain("Sign in again");
    expect(html).toContain("Your email wallet (Privy)");
    expect(html).not.toContain("Your key on this device");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sign in<\/button>/);
    expect(render({ ...withPrivy, wallet: privyWallet })).toMatch(/<button[^>]*(?<!disabled="")>Sign in<\/button>/);
  });

  it("tells a returning Privy user that Privy isn't answering instead of waiting forever", () => {
    const html = render({ ...privyDown, wallet: privyWallet });
    expect(html).toContain("Sign in again");
    expect(html).toMatch(new RegExp(`Sign in again(?:(?!</section>).)*${PRIVY_DOWN}`));
    expect(html).not.toContain("Opening Privy…");
    expect(html).toMatch(/<button[^>]*(?<!disabled="")>Sign in<\/button>/);
  });

  it("names a connected Freighter wallet Varial (formerly Freighter), signed in or not (O-30)", () => {
    const freighterWallet = { ...privyWallet, kind: "freighter" };
    expect(render({ ...base, wallet: freighterWallet }, freighterWallet.publicKey)).toMatch(/Varial \(formerly Freighter\) ·/);
    expect(render({ ...base, wallet: freighterWallet })).toContain("Your Varial (formerly Freighter) account");
  });

  it("offers a way out of a Privy session on another account: Use a different account (N1)", () => {
    const html = render({ ...withPrivy, wallet: privyWallet });
    expect(html).toMatch(/Sign in again(?:(?!<\/section>).)*<button[^>]*>Use a different account<\/button>/);
    const device = render({ ...withPrivy, wallet: { ...privyWallet, kind: "device" } });
    expect(device).toContain("Sign in again");
    expect(device).not.toContain("Use a different account");
  });
});
