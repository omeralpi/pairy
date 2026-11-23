import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The form as it first renders for one side. `side` is the only state that
// starts at "sell_crypto", so swapping that initial value is enough to see
// the buy side without a browser.
const initial = vi.hoisted(() => ({ side: "sell_crypto" }));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useState: (v: unknown) => react.useState(v === "sell_crypto" ? initial.side : v) };
});
vi.mock("@/lib/api", () => ({
  api: {
    useUtils: () => ({ listing: { invalidate: async () => {} } }),
    listing: { create: { useMutation: () => ({ mutate: () => {}, isPending: false, error: null }) } },
  },
}));
vi.mock("@/components/listing/city-picker", () => ({ CityPicker: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const { ListingForm } = await import("./listing-form");

const labelFor = (html: string, id: string) => html.match(new RegExp(`<label[^>]*for="${id}"[^>]*>([^<]*)<`))?.[1];

describe("ListingForm amount labels (F-17)", () => {
  it("calls the maximum the total to offer when selling crypto", () => {
    initial.side = "sell_crypto";
    const html = renderToStaticMarkup(<ListingForm />);
    expect(labelFor(html, "max")).toBe("Total to offer (USDC)");
    expect(labelFor(html, "min")).toBe("Min USDC");
  });

  it("calls the maximum the total to buy when buying crypto", () => {
    initial.side = "buy_crypto";
    const html = renderToStaticMarkup(<ListingForm />);
    expect(labelFor(html, "max")).toBe("Total to buy (USDC)");
  });
});
