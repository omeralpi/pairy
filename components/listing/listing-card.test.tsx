import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListingCard } from "./listing-card";

const listing = {
  id: "11111111-1111-4111-8111-111111111111",
  side: "sell_crypto",
  asset: "USDC",
  minAmount: "10.0000000",
  maxAmount: "100.0000000",
  remainingAmount: "100.0000000",
  rate: "41.2500",
  fiatCode: "TRY",
  cityName: "Istanbul",
  countryCode: "TR",
};

describe("ListingCard", () => {
  it("says how much is left once a trade has taken part of the listing", () => {
    const html = renderToStaticMarkup(<ListingCard listing={{ ...listing, remainingAmount: "40.0000000" } as never} />);
    expect(html).toContain("40 of 100 USDC left");
  });

  it("says nothing about what is left while the whole listing is still available", () => {
    expect(renderToStaticMarkup(<ListingCard listing={listing as never} />)).not.toContain("left");
  });
});
