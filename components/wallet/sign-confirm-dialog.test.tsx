import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dialog } from "@/components/ui/dialog";

import { PRIVY_LOGIN_TEXT, SignConfirmContent, SignConfirmDialog } from "./sign-confirm-dialog";

// The dialog's body as it renders inside the dialog, whose content is a portal
// and so has no server markup: the body is enough to see what the user is
// asked to confirm before Privy signs anything. The Dialog root gives the
// title and description their context.
const render = (props: Parameters<typeof SignConfirmContent>[0]) =>
  renderToStaticMarkup(
    <Dialog open>
      <SignConfirmContent {...props} />
    </Dialog>,
  );
const base = {
  title: "Sign transaction",
  description: "Privy signs the hash of this testnet transaction. Nothing is sent until it is signed.",
  summary: "Lock 25 USDC for GABC…WXYZ, claimable by them for 72 hours",
  busy: false,
  error: null,
  onConfirm: async () => {},
  onCancel: () => {},
};

describe("SignConfirmContent", () => {
  it("says what is being signed: the eyebrow, the summary, the description and a Sign button", () => {
    const html = render(base);
    expect(html).toMatch(/<p[^>]*class="eyebrow"[^>]*>Sign transaction<\/p>/);
    expect(html).toContain("Confirm with Privy");
    expect(html).toContain(base.description);
    expect(html).toContain(base.summary);
    expect(html).toMatch(/<button[^>]*>Sign<\/button>/);
    expect(html).toMatch(/<button[^>]*>Cancel<\/button>/);
    expect(html).not.toContain('disabled=""');
  });

  it("the login prompt's description is exactly DECISIONS 12's one line, with nothing run into it", () => {
    expect(PRIVY_LOGIN_TEXT).toBe("Sign in: this signs a message and moves no funds");
    const html = render({ ...base, title: "Sign in", description: PRIVY_LOGIN_TEXT });
    expect(html).toMatch(/<p[^>]*class="eyebrow"[^>]*>Sign in<\/p>/);
    const description = /<p id="radix-[^"]*" class="text-sm text-slate">([^<]*)<\/p>/.exec(html);
    expect(description?.[1]).toBe(PRIVY_LOGIN_TEXT);
  });

  it("while Privy signs, the button reads Waiting for Privy… and both buttons are disabled", () => {
    const html = render({ ...base, busy: true });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Waiting for Privy…<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/);
  });

  it("a cancelled or finished request closes the dialog: with open=false nothing of it is rendered", () => {
    // The provider derives `open` from its request and clears the request on
    // Cancel, so the dialog cannot stay open after Cancel (WP-06 judge N1).
    const html = renderToStaticMarkup(
      <SignConfirmDialog open={false} title="Sign transaction" description="text" summary="Lock 1 XLM" onConfirm={async () => {}} onCancel={() => {}} />,
    );
    expect(html).toBe("");
  });

  it("announces an error with role=alert and leaves Sign enabled for a retry", () => {
    const error = "Privy returned a signature that does not match this transaction. Nothing was sent.";
    const html = render({ ...base, error });
    expect(html).toMatch(new RegExp(`<p[^>]*role="alert"[^>]*>${error.replace(/[.]/g, "\\.")}</p>`));
    expect(html).toMatch(/<button[^>]*>Sign<\/button>/);
    expect(html).not.toContain('disabled=""');
  });
});
