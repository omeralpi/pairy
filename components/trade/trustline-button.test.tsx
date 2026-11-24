import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The button as it first renders for a buyer whose wallet is still loading.
// No browser: the markup shows which asset the copy and the button name.
vi.mock("@/lib/wallet/use-wallet", () => ({ useWallet: () => ({ wallet: null, ready: false }) }));

const { TrustlineButton } = await import("./trustline-button");

const BUYER = "GBUYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const buttonText = (html: string) => html.match(/<button[^>]*>([^<]*)<\/button>/)?.[1];

describe("TrustlineButton", () => {
  it("names EURC in the explanation and on the button", () => {
    const html = renderToStaticMarkup(<TrustlineButton asset="EURC" buyer={BUYER} onDone={() => {}} />);
    expect(html).toContain("Add EURC to your wallet before the seller locks it for you.");
    expect(buttonText(html)).toBe("Add EURC to my wallet");
    expect(html).not.toContain("USDC");
  });

  it("keeps the claim wording once the seller has locked", () => {
    const html = renderToStaticMarkup(<TrustlineButton asset="EURC" buyer={BUYER} locked onDone={() => {}} />);
    expect(html).toContain("Add EURC to your wallet so your claim can go through.");
    expect(buttonText(html)).toBe("Add EURC to my wallet");
  });

  it("says the escrow needs it in a protected trade, with no lock or claim", () => {
    const html = renderToStaticMarkup(<TrustlineButton asset="USDC" buyer={BUYER} escrow onDone={() => {}} />);
    expect(html).toContain("Add USDC to your wallet before the seller creates the escrow. Without it, the escrow can&#x27;t be created.");
    expect(html).not.toMatch(/lock|claim/);
    expect(buttonText(html)).toBe("Add USDC to my wallet");
  });

  it("still says USDC for USDC", () => {
    const html = renderToStaticMarkup(<TrustlineButton asset="USDC" buyer={BUYER} onDone={() => {}} />);
    expect(buttonText(html)).toBe("Add USDC to my wallet");
    expect(html).not.toContain("EURC");
  });
});
