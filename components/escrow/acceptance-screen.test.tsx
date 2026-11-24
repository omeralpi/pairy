import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ACCEPTANCE_ITEMS, ACCEPTANCE_TITLE, ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";
import { ARBITER_ACCOUNT } from "@/lib/escrow/config";

const { AcceptanceScreen } = await import("./acceptance-screen");

// React escapes text nodes; undo it so the comparison is with the exact characters on screen.
const unescape = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const render = (accepted: boolean) =>
  renderToStaticMarkup(<AcceptanceScreen accepted={accepted} onAcceptedChange={() => {}} />);

describe("AcceptanceScreen", () => {
  it("shows the title and the seven items of lib/escrow/acceptance.ts, character for character, in order", () => {
    const html = render(false);
    expect(unescape(html.match(/<h2[^>]*>([^<]*)<\/h2>/)?.[1] ?? "")).toBe(ACCEPTANCE_TITLE);
    const list = html.match(/<ol[^>]*>(.*?)<\/ol>/)?.[1] ?? "";
    const items = [...list.matchAll(/<li[^>]*>([^<]*)<\/li>/g)].map((m) => unescape(m[1]));
    expect(items).toEqual([...ACCEPTANCE_ITEMS]);
  });

  it("shows the version a trader accepts", () => {
    expect(render(false)).toContain(ACCEPTANCE_VERSION);
  });

  it("links the arbiter account (signers and thresholds) on stellar.expert and the published rule", () => {
    const html = render(false);
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/account/${ARBITER_ACCOUNT}"`);
    expect(html).toContain('href="https://github.com/omeralpi/pairy/blob/main/docs/arbitration.md"');
  });

  it("is accepted only through its own checkbox", () => {
    const unchecked = render(false);
    expect(unchecked).toMatch(/<input[^>]*type="checkbox"[^>]*>/);
    expect(unchecked).not.toMatch(/<input[^>]*checked=""[^>]*>/);
    expect(unchecked).toContain("I accept");
    expect(render(true)).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""[^>]*>/);
  });
});
