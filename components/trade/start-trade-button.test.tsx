import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ACCEPTANCE_ITEMS, ACCEPTANCE_TITLE, ACCEPTANCE_VERSION } from "@/lib/escrow/acceptance";

// The start-trade form for one listing.byId result; the viewer is signed in
// and is not the owner.
const byId = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));
// What escrow.config answers (undefined while it loads) and which wallet is connected.
const config = vi.hoisted(() => ({ result: undefined as Record<string, unknown> | undefined }));
const wallet = vi.hoisted(() => ({ result: { wallet: null, ready: true } as { wallet: unknown; ready: boolean } }));
// The form as it first renders: each state below is the only one that starts
// at that value, so swapping it shows a later step without a browser.
const initial = vi.hoisted(() => ({ amount: "", mode: "claimable", accepted: false }));
// What trade.open was asked to open.
const opened = vi.hoisted(() => [] as unknown[]);

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  const swap = (v: unknown) =>
    v === "" ? initial.amount : v === "claimable" ? initial.mode : v === false ? initial.accepted : v;
  return { ...react, useState: (v: unknown) => react.useState(swap(v)) };
});
vi.mock("@/lib/api", () => ({
  api: {
    trade: { open: { useMutation: () => ({ mutate: (input: unknown) => void opened.push(input), isPending: false, error: null }) } },
    listing: { byId: { useQuery: () => ({ data: byId.result, error: null, isLoading: false }) } },
    escrow: { config: { useQuery: () => ({ data: config.result }) } },
  },
}));
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => ({ publicKey: "GBUYER", loading: false }) }));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWallet: () => wallet.result }));
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

describe("StartTradeButton protected toggle", () => {
  const usdc = { ...listing, asset: "USDC" };
  const on = { enabled: true, protectedWalletKinds: ["device", "freighter", "privy"] };
  const device = { wallet: { publicKey: "GBUYER", kind: "device" }, ready: true };
  const toggle = /<input[^>]*id="protected-trade"[^>]*>/;
  const submit = (html: string) => html.match(/<button[^>]*type="submit"[^>]*>([^<]*)<\/button>/);
  type Setup = {
    listing?: Record<string, unknown>;
    config?: Record<string, unknown>;
    wallet?: object;
    mode?: string;
    accepted?: boolean;
    amount?: string;
  };
  const setup = (o: Setup) => {
    byId.result = o.listing ?? usdc;
    config.result = "config" in o ? (o.config as Record<string, unknown> | undefined) : on;
    wallet.result = (o.wallet ?? device) as typeof wallet.result;
    initial.mode = o.mode ?? "claimable";
    initial.accepted = o.accepted ?? false;
    initial.amount = o.amount ?? "";
    return render();
  };

  it("is off by default for a USDC listing, a device key and protected mode on", () => {
    const html = setup({});
    expect(html.match(toggle)?.[0]).toContain('type="checkbox"');
    expect(html.match(toggle)?.[0]).not.toContain("checked");
    expect(html).toContain("Protected trade");
    expect(html).not.toContain(ACCEPTANCE_ITEMS[0]);
    expect(submit(html)?.[1]).toBe("Start trade");
  });

  it("is shown for Freighter and an email wallet too, as the config allows", () => {
    expect(setup({ wallet: { wallet: { publicKey: "GBUYER", kind: "freighter" }, ready: true } })).toMatch(toggle);
    expect(setup({ wallet: { wallet: { publicKey: "GBUYER", kind: "privy" }, ready: true } })).toMatch(toggle);
  });

  it("is hidden, with no word about protected trades, while protected mode is off", () => {
    const html = setup({ config: { ...on, enabled: false } });
    expect(html).not.toMatch(toggle);
    expect(html).not.toContain("rotected");
    expect(submit(html)?.[1]).toBe("Start trade");
  });

  it("is hidden while escrow.config or the wallet is still loading", () => {
    expect(setup({ config: undefined })).not.toContain("rotected");
    expect(setup({ wallet: { wallet: null, ready: false } })).not.toContain("rotected");
  });

  it("is hidden for XLM and EURC listings, saying why", () => {
    for (const asset of ["XLM", "EURC"]) {
      const html = setup({ listing: { ...listing, asset } });
      expect(html).not.toMatch(toggle);
      expect(html).toContain("Protected trades work with USDC only for now.");
    }
  });

  it("is hidden for a wallet kind protected mode does not allow, saying which kinds work", () => {
    const html = setup({
      config: { ...on, protectedWalletKinds: ["device", "freighter"] },
      wallet: { wallet: { publicKey: "GBUYER", kind: "privy" }, ready: true },
    });
    expect(html).not.toMatch(toggle);
    expect(html).toContain("Protected trades work with a key on this device or Varial (formerly Freighter) for now.");
  });

  it("is hidden with no wallet connected, saying so", () => {
    const html = setup({ wallet: { wallet: null, ready: true } });
    expect(html).not.toMatch(toggle);
    expect(html).toContain("Connect your wallet to choose a protected trade.");
  });

  it("once on, shows the acceptance text from ACCEPTANCE_ITEMS", () => {
    const html = setup({ mode: "protected" });
    expect(html.match(toggle)?.[0]).toContain('checked=""');
    expect(html).toContain(ACCEPTANCE_TITLE);
    const list = html.match(/<ol[^>]*>(.*?)<\/ol>/)?.[1] ?? "";
    expect((list.match(/<li[^>]*>/g) ?? []).length).toBe(ACCEPTANCE_ITEMS.length);
  });

  it("keeps Accept and start protected trade disabled until I accept", () => {
    const before = submit(setup({ mode: "protected", amount: "20" }));
    expect(before?.[1]).toBe("Accept and start protected trade");
    expect(before?.[0]).toContain('disabled=""');

    const after = submit(setup({ mode: "protected", amount: "20", accepted: true }));
    expect(after?.[1]).toBe("Accept and start protected trade");
    expect(after?.[0]).not.toContain('disabled=""');
  });

  it("still needs an amount in bounds once accepted", () => {
    expect(submit(setup({ mode: "protected", amount: "200", accepted: true }))?.[0]).toContain('disabled=""');
  });

  it("opens with the mode and the acceptance text's version only for an accepted protected trade (WP-30 N1)", () => {
    // The form's own submit handler, read from the element StartTradeButton returns.
    const submitWith = (o: Setup) => {
      setup(o);
      opened.length = 0;
      let form: { props: { onSubmit: (e: { preventDefault: () => void }) => void } } | undefined;
      function Probe() {
        form = StartTradeButton({ listingId: "l" }) as never;
        return null;
      }
      renderToStaticMarkup(<Probe />);
      form!.props.onSubmit({ preventDefault: () => {} });
      return [...opened];
    };
    expect(submitWith({ mode: "protected", amount: "20", accepted: true })).toEqual([
      { listingId: "l", amount: "20", mode: "protected", acceptanceVersion: ACCEPTANCE_VERSION },
    ]);
    expect(submitWith({ mode: "protected", amount: "20" })).toEqual([]);
    expect(submitWith({ amount: "20" })).toEqual([{ listingId: "l", amount: "20" }]);
  });

  it("drops the acceptance screen when the toggle is not allowed any more", () => {
    const html = setup({ listing: { ...listing, asset: "XLM" }, mode: "protected", amount: "20", accepted: true });
    expect(html).not.toContain(ACCEPTANCE_TITLE);
    expect(submit(html)?.[1]).toBe("Start trade");
  });
});
