import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { shortWhen } from "@/components/trade/format";
import { TRADE_STATES } from "@/lib/trade/state-machine";

// The trades list as it renders for one trade.mine answer. No browser: the
// markup shows the groups, their order and each row's line.
const mine = vi.hoisted(() => ({ data: [] as Record<string, unknown>[] }));

vi.mock("@/lib/api", () => ({
  api: {
    useUtils: () => ({ auth: { me: { invalidate: () => {} } } }),
    trade: { mine: { useQuery: () => ({ data: mine.data, error: null, isLoading: false }) } },
  },
}));
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => ({ publicKey: "GSELLER", loading: false }) }));

const { default: TradesPage } = await import("./page");

const recorded = new Date("2026-12-01T10:00:00Z");
let n = 0;
const row = (t: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  mode: "protected",
  state: "funded",
  role: "seller",
  openedBy: "buyer",
  seller: "GSELLER",
  buyer: "GBUYER",
  counterparty: "GBUYER",
  asset: "USDC",
  amount: "10.0000000",
  fiatAmount: "9.20",
  fiatCode: "EUR",
  cityName: "Berlin",
  windowSeconds: 0,
  disputed: false,
  lockTx: null,
  lockedAt: null,
  createTx: "c".repeat(64),
  fundTx: "f".repeat(64),
  disputeRecordedAt: null,
  disputedAt: null,
  ...t,
});
const render = (rows: Record<string, unknown>[]) => {
  mine.data = rows;
  return renderToStaticMarkup(<TradesPage />);
};
const headers = (html: string) => [...html.matchAll(/<h2 class="eyebrow">([^<]*)<\/h2>/g)].map((m) => m[1]);

describe("TradesPage groups", () => {
  it("lists every state, live trades first, merging states that share a label", () => {
    const html = render(TRADE_STATES.map((state) => row({ state, mode: state.startsWith("resolved") || ["escrow_created", "funded", "released"].includes(state) ? "protected" : "claimable" })));
    expect(headers(html)).toEqual([
      "Funded",
      "In escrow",
      "Locked",
      "Agreed",
      "Waiting to agree",
      "Settled",
      "Settled by the arbiter",
      "Taken back",
      "Cancelled",
    ]);
    expect(html.match(/<li>/g)).toHaveLength(TRADE_STATES.length);
  });

  it("puts a released protected trade and a claimed trade under one Settled header", () => {
    const html = render([row({ state: "claimed", mode: "claimable", asset: "XLM" }), row({ state: "released" })]);
    expect(headers(html)).toEqual(["Settled"]);
    expect(html).toContain("Settled. The buyer received 9.97 USDC.");
    expect(html).toContain("Settled. The XLM is in the buyer&#x27;s wallet.");
  });

  it("never offers a lock or a claim on a protected row", () => {
    const html = render(["listed", "agreed", "escrow_created", "funded", "released", "resolved_buyer", "resolved_seller"].map((state) => row({ state })));
    expect(html).not.toMatch(/lock|claim/i);
    expect(html).toContain("Funded. Release only when you hold the cash.");
  });
});

describe("TradesPage dispute badge", () => {
  it("shows the answer deadline on a disputed protected trade instead of the flag note", () => {
    const html = render([row({ disputed: true, disputeRecordedAt: recorded, disputedAt: recorded })]);
    expect(html).toContain(`Dispute open: answer by ${shortWhen(new Date("2026-12-02T10:00:00Z"))}`);
    expect(html).not.toContain("A problem was flagged.");
    expect(html).toContain("Dispute open. Only the arbiter can settle this escrow now.");
  });

  it("keeps the flag note for a claimable trade", () => {
    const html = render([row({ mode: "claimable", state: "agreed", asset: "XLM", disputed: true })]);
    expect(html).toContain("A problem was flagged.");
    expect(html).not.toContain("Dispute open");
  });
});
