import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const query = (data: unknown) => () => ({ data, error: null, isLoading: false, dataUpdatedAt: 0 });

vi.mock("@/lib/api", () => ({
  api: {
    trade: {
      claimWindow: { useQuery: query(undefined) },
      lockPreflight: { useQuery: query(undefined) },
      open: { useMutation: () => ({ mutate: () => {}, isPending: false, error: null }) },
    },
    listing: {
      byId: {
        useQuery: query({
          owner: "GOWNER",
          status: "active",
          minAmount: "10",
          maxAmount: "100",
          asset: "XLM",
          side: "sell_crypto",
          rate: "40",
          fiatCode: "TRY",
        }),
      },
    },
  },
}));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWallet: () => ({ wallet: null, ready: true }) }));
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => ({ publicKey: "GBUYER", loading: false }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

describe("money-step accessibility", () => {
  it("announces the trade's status line when it changes (WCAG 4.1.3)", async () => {
    const { StatusLine } = await import("./trade-room");
    const html = renderToStaticMarkup(
      <StatusLine trade={{ state: "agreed", role: "seller", openedBy: "buyer", asset: "XLM", id: "t" } as never} />,
    );
    expect(html).toMatch(/<p[^>]*role="status"[^>]*>Agreed\. Lock when/);
  });

  it("ties the amount hint (cash total or what is wrong) to the amount field (WCAG 1.3.1, 3.3.1)", async () => {
    const { StartTradeButton } = await import("./start-trade-button");
    const html = renderToStaticMarkup(<StartTradeButton listingId="l" />);
    const describedBy = html.match(/id="trade-amount"[^>]*aria-describedby="([^"]+)"|aria-describedby="([^"]+)"[^>]*id="trade-amount"/);
    expect(describedBy).not.toBeNull();
    const id = describedBy![1] ?? describedBy![2];
    expect(html).toContain(`id="${id}"`);
    expect(html).toMatch(new RegExp(`id="${id}"[^>]*>[^<]*You will be the buyer`));
  });
});
