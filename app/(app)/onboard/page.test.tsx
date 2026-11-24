import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The onboarding page as it renders for one wallet context; no browser, so
// effects do not run and the markup is enough to see which choices are offered
// and what the headline promises.
const ctx = vi.hoisted(() => ({ value: {} as Record<string, unknown>, session: null as string | null }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("@/lib/auth/use-login", () => ({ useLogin: () => ({ login: async () => {}, logout: async () => {}, pending: false }) }));
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => ({ publicKey: ctx.session, loading: false }) }));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWalletContext: () => ctx.value }));

const { default: OnboardPage } = await import("./page");

const base = {
  wallet: null,
  ready: true,
  deviceWalletPublicKey: null,
  connectPrivy: null,
  exportPrivyKey: null,
  privy: { enabled: false, ready: false, authenticated: false, loginLabel: null },
};
const withPrivy = {
  ...base,
  connectPrivy: async () => ({}),
  exportPrivyKey: async () => {},
  privy: { enabled: true, ready: true, authenticated: false, loginLabel: null },
};
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
      "A wallet is made for you and opens again wherever you sign in. The key is split and held by Privy, not by Pairy. Whoever controls that email or Google account controls this wallet.",
    );
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
});
