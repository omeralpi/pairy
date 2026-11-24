import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The start-trade form for one listing.byId result; the viewer is signed in
// and is not the owner.
const byId = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));

vi.mock("@/lib/api", () => ({
  api: {
    trade: { open: { useMutation: () => ({ mutate: () => {}, isPending: false, error: null }) } },
    listing: { byId: { useQuery: () => ({ data: byId.result, error: null, isLoading: false }) } },
  },
}));
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => ({ publicKey: "GBUYER", loading: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const { StartTradeButton } = await import("./start-trade-button");

const listing = {
  owner: "GOWNER",
  status: "active",
  side: "sell_crypto",
  asset: "XLM",
  minAmount: "10.0000000",
  maxAmount: "100.0000000",
  remainingAmount: "100.0000000",
  rate: "40.0000",
  fiatCode: "TRY",
};
const render = () => renderToStaticMarkup(<StartTradeButton listingId="l" />);

describe("StartTradeButton bounds", () => {
  it("offers the whole range while nothing has been taken", () => {
    byId.result = listing;
    expect(render()).toContain("10 to 100 XLM");
  });

  it("stops at what is left, not at the listing's total", () => {
    byId.result = { ...listing, remainingAmount: "40.0000000" };
    const html = render();
    expect(html).toContain("10 to 40 XLM");
    expect(html).not.toContain("10 to 100 XLM");
  });

  it("has no amount field when less than the minimum is left", () => {
    byId.result = { ...listing, remainingAmount: "5.0000000" };
    const html = render();
    expect(html).toContain("Not enough left on this listing right now. It comes back when a trade on it is cancelled.");
    expect(html).not.toContain('id="trade-amount"');
  });
});
