import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

// The site's own description, in the page metadata and the web app manifest.
// It must hold for a protected trade too, where the arbiter (the Pairy team)
// can move a disputed escrow: what never holds a key or signs is Pairy's
// server, as README says (O-41).
vi.mock("next/font/google", () => {
  const font = () => ({ variable: "" });
  return { JetBrains_Mono: font, Newsreader: font, Space_Grotesk: font };
});
vi.mock("@/components/providers/trpc-provider", () => ({ TRPCProvider: () => null }));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));

const { metadata } = await import("./layout");
const { default: manifest } = await import("./manifest");

const CLAIM = "Pairy's server holds no Stellar signing key and never signs or sends a transaction.";

describe("the site description", () => {
  it("says what Pairy's server never does, in the metadata and the manifest", () => {
    for (const description of [metadata.description, manifest().description]) {
      expect(description).toContain(CLAIM);
      expect(description).not.toMatch(/Pairy holds no key|never touches the funds/);
    }
  });

  it("agrees with README's sentence on the server", () => {
    const readme = readFileSync(path.join(process.cwd(), "README.md"), "utf8");
    expect(readme).toContain("Pairy's server never signs, never submits a transaction for anyone and never sees a private key.");
  });
});
