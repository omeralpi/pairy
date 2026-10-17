// WCAG AA (1.4.3): text needs 4.5:1 against its background. Reads the colour
// tokens straight from tailwind.config.ts and the beacon button fill from
// components/ui/button.tsx, so a token change that breaks contrast fails here.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const config = readFileSync(path.join(root, "tailwind.config.ts"), "utf8");
const button = readFileSync(path.join(root, "components/ui/button.tsx"), "utf8");

function token(name: string): string {
  const m = config.match(new RegExp(`\\b${name}: "(#[0-9A-Fa-f]{6})"`));
  if (!m) throw new Error(`no ${name} token`);
  return m[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("colour contrast (Q-8)", () => {
  const paper = token("paper");
  const sand = token("sand");

  it.each(["ink", "slate", "success", "warning", "danger"])("%s text meets 4.5:1 on paper and sand", (name) => {
    expect(ratio(token(name), paper)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(token(name), sand)).toBeGreaterThanOrEqual(4.5);
  });

  it("the beacon button's white label meets 4.5:1 on its fill", () => {
    const fill = button.match(/beacon: "bg-beacon(?:-(\d+))? text-white/);
    expect(fill).not.toBeNull();
    const shade = fill![1] ?? "DEFAULT";
    // Only the beacon palette: another palette may define the same shade.
    const beacon = config.match(/beacon: \{([^}]*)\}/)![1];
    const hex = beacon.match(new RegExp(`\\b${shade}: "(#[0-9A-Fa-f]{6})"`))![1];
    expect(ratio("#FFFFFF", hex)).toBeGreaterThanOrEqual(4.5);
  });

  it("mist is never used for placeholders, which sit on paper", () => {
    expect(ratio(token("mist"), paper)).toBeLessThan(4.5);
    const files = ["components/listing/listing-form.tsx", "components/listing/city-picker.tsx"];
    for (const f of files) expect(readFileSync(path.join(root, f), "utf8")).not.toMatch(/text-mist/);
  });
});
