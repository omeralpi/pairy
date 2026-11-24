// Docs ⇔ code (D2 §10.4): the acceptance screen the app shows is the text
// docs/arbitration.md publishes, byte for byte, and its version is the hash of
// exactly that text. The docs carry SOW D2's text word for word (WP-01).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ACCEPTANCE_ITEMS, ACCEPTANCE_TITLE, ACCEPTANCE_VERSION } from "./acceptance";

const docs = readFileSync(path.join(process.cwd(), "docs/arbitration.md"), "utf8");

describe("the acceptance text", () => {
  it("is docs/arbitration.md's quoted screen, title then items 1 to 7, line for line", () => {
    expect(ACCEPTANCE_ITEMS).toHaveLength(7);
    const quoted = [`> ${ACCEPTANCE_TITLE}`, ...ACCEPTANCE_ITEMS.map((item, i) => `> ${i + 1}. ${item}`)].join("\n");
    expect(docs).toContain(`\n${quoted}\n`);
  });

  it("has one version: the sha256 of the title and the items, one per line", () => {
    const text = [ACCEPTANCE_TITLE, ...ACCEPTANCE_ITEMS].join("\n");
    expect(ACCEPTANCE_VERSION).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    // Pinned, so any edit to the text is a deliberate change of version.
    expect(ACCEPTANCE_VERSION).toBe("c785c11af71efc1a2cc999304209063a945fba9762db11178cd4a4f0f5cc17b5");
  });
});
