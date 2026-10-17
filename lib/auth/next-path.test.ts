import { describe, expect, it } from "vitest";

import { safeNextPath } from "./next-path";

const ORIGIN = "https://pairy.org";
/** What `?next=<raw>` decodes to in the browser. */
const next = (raw: string) => new URLSearchParams(`next=${raw}`).get("next");

describe("safeNextPath (Q-26, F1)", () => {
  it("keeps a path on this site", () => {
    expect(safeNextPath("/trades/5b0c9a52-1f7e-4c1b-9d0e-2a4f6b8c0d1e", ORIGIN)).toBe(
      "/trades/5b0c9a52-1f7e-4c1b-9d0e-2a4f6b8c0d1e",
    );
    expect(safeNextPath("/trades?x=1#chat", ORIGIN)).toBe("/trades?x=1#chat");
  });

  it("drops anything that could leave the site", () => {
    for (const v of [null, "", "https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      expect(safeNextPath(v, ORIGIN)).toBeNull();
    }
  });

  it.each(["/%09/evil.example", "/%0a/evil.example", "/%0d/evil.example", "/%09%5Cevil.example"])(
    "drops %s, which the URL parser turns into //evil.example",
    (raw) => {
      const kept = safeNextPath(next(raw), ORIGIN);
      expect(kept === null || new URL(kept, `${ORIGIN}/onboard`).origin === ORIGIN).toBe(true);
    },
  );
});
