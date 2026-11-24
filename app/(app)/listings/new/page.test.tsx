import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The new-listing page for a visitor who is not signed in: the hint names the
// ways in, and what it says about the key holds for each of them (O-40).
const ctx = vi.hoisted(() => ({ privyEnabled: true }));

vi.mock("@/lib/auth/use-session", () => ({ useSession: () => ({ publicKey: null, loading: false }) }));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWalletContext: () => ({ privy: { enabled: ctx.privyEnabled } }) }));
vi.mock("@/components/listing/listing-form", () => ({ ListingForm: () => null }));

const { default: NewListingPage } = await import("./page");

const render = (privyEnabled: boolean) => {
  ctx.privyEnabled = privyEnabled;
  return renderToStaticMarkup(<NewListingPage />);
};

describe("NewListingPage signed out", () => {
  it("names the email or Google option with an App ID, and Varial (formerly Freighter) and the device key", () => {
    expect(render(true)).toContain(
      "A listing belongs to a Stellar public key. Sign in with email or Google, connect Varial (formerly Freighter), or create a testnet wallet on this device. Pairy never gets the key.",
    );
  });

  it("leaves the email option out without an App ID", () => {
    const html = render(false);
    expect(html).toContain(
      "A listing belongs to a Stellar public key. Connect Varial (formerly Freighter) or create a testnet wallet on this device. Pairy never gets the key.",
    );
    expect(html).not.toContain("email");
  });

  it("no longer says the key stays with you, which a Privy wallet does not do", () => {
    expect(render(true)).not.toContain("the key stays with you");
  });
});
