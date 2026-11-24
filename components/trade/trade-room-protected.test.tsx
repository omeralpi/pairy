import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The trade room's read-only surfaces for a protected trade (WP-31): the
// status line, the term box, the timeline and "How this is enforced". The
// action panels are other work packages' and are not asserted on here.
const byId = vi.hoisted(() => ({ result: {} as Record<string, unknown> }));

vi.mock("@/lib/api", () => {
  const query = (path: string[]) =>
    path.join(".") === "trade.byId"
      ? byId.result
      : { data: undefined, error: null, isLoading: true, isFetching: true };
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_, key: string) => {
        if (key === "useQuery") return () => query(path);
        if (key === "useMutation") return () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false });
        if (key === "useUtils") return () => node([]);
        return node([...path, key]);
      },
    });
  return { api: node([]) };
});
vi.mock("@/lib/auth/use-session", () => ({ useSession: () => ({ publicKey: "GSELLER", loading: false }) }));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWallet: () => ({ wallet: null, ready: true }) }));
vi.mock("@/components/trade/use-trade-sync", () => ({ useTradeSync: () => {} }));
vi.mock("@/components/chat/chat-panel", () => ({ ChatPanel: () => null }));
vi.mock("@/components/trade/lock-panel", () => ({ LockPanel: () => <p>LOCK PANEL</p> }));

const { TradeRoom } = await import("./trade-room");

const id = "11111111-1111-4111-8111-111111111111";
const contract = "CDQOPLC2P7JNMMT62WDCC5EW5ESLFCHSAVQ66X7EWFE7E3QPT674QO34";
const at = new Date("2026-12-01T10:00:00Z");
const event = (type: string, by: string, txHash: string | null = null) => ({
  id: `${type}-${by}`,
  tradeId: id,
  type,
  by,
  txHash,
  createdAt: at,
  txUrl: txHash ? `https://stellar.expert/explorer/testnet/tx/${txHash}` : null,
});
const trade = {
  id,
  listingId: "22222222-2222-4222-8222-222222222222",
  mode: "protected",
  state: "agreed",
  role: "seller",
  openedBy: "buyer",
  seller: "GSELLER",
  buyer: "GBUYER",
  counterparty: "GBUYER",
  counterpartyUrl: "https://stellar.expert/explorer/testnet/account/GBUYER",
  asset: "USDC",
  amount: "10.0000000",
  fiatAmount: "9.20",
  fiatCode: "EUR",
  rate: "0.9200",
  cityName: "Berlin",
  windowSeconds: 0,
  disputed: false,
  balanceId: null,
  lockTx: null,
  claimTx: null,
  reclaimTx: null,
  escrowContractId: null,
  escrowAdmin: null,
  createTx: null,
  fundTx: null,
  releaseTx: null,
  disputeTx: null,
  resolveTx: null,
  fundedAt: null,
  disputedAt: null,
  disputeRecordedAt: null,
  disputeOpenedBy: null,
  resolvedAt: null,
  viewerUrl: null,
  stallNudge: false,
  events: [event("open", "buyer"), event("agree", "seller")],
};
const created = {
  ...trade,
  state: "escrow_created",
  escrowContractId: contract,
  escrowAdmin: "GA4YXFZ6QJ7R3A6OJ5Q7G3W2K4XQFN6Y3H2T5B3Q7W2K4XQFN6Y3ZPRP",
  createTx: "c".repeat(64),
  viewerUrl: `https://viewer.trustlesswork.com/testnet/v2/${contract}`,
  events: [...trade.events, event("escrowCreate", "seller", "c".repeat(64))],
};
const funded = { ...created, state: "funded", fundTx: "f".repeat(64), fundedAt: at, events: [...created.events, event("fund", "seller", "f".repeat(64))] };
const room = (t: Record<string, unknown>) => {
  byId.result = { data: t, error: null, isLoading: false };
  return renderToStaticMarkup(<TradeRoom id={id} />);
};
const status = (html: string) => html.match(/<p role="status"[^>]*>([^<]*)<\/p>/)?.[1]?.replaceAll("&#x27;", "'");

describe("TradeRoom read-only surfaces for a protected trade", () => {
  it("shows the protected status line and no claimable window in the term box", () => {
    const html = room(trade);
    expect(status(html)).toBe("Agreed. Create the escrow when you're ready.");
    expect(html).not.toContain("window 0 h");
    expect(html).not.toContain("· window");
    expect(html).toContain("· protected trade · Trustless Work escrow");
  });

  it("explains the escrow instead of the claimable balance under How this is enforced", () => {
    const html = room(trade);
    expect(html).toContain("How this is enforced");
    expect(html).toContain("No escrow exists yet.");
    expect(html).not.toMatch(/claimable balance|CAP-23|BEFORE_RELATIVE_TIME|Balance ID/);
  });

  it("links the escrow and its receipts once it exists, and reads the funded line to the seller", () => {
    const html = room(funded);
    expect(status(html)).toBe("Funded. Release only when you hold the cash.");
    expect(html).toContain(`href="https://viewer.trustlesswork.com/testnet/v2/${contract}"`);
    expect(html).toContain("Create receipt");
    expect(html).toContain("Fund receipt");
    expect(html).toContain("You created the escrow.");
    expect(html).toContain("You funded the escrow with 10 USDC.");
  });

  it("marks a release as settled through the escrow, with what the buyer received", () => {
    const html = room({ ...funded, state: "released", releaseTx: "r".repeat(64), events: [...funded.events, event("release", "seller", "r".repeat(64))] });
    expect(status(html)).toBe("Settled. The buyer received 9.97 USDC.");
    expect(html).toContain("✓ settled through the escrow");
    expect(html).not.toContain("settled in person");
    expect(html).toContain("Release receipt");
  });

  it("marks a resolution as settled by the arbiter", () => {
    const html = room({
      ...funded,
      state: "resolved_seller",
      disputed: true,
      disputeTx: "d".repeat(64),
      resolveTx: "e".repeat(64),
      events: [...funded.events, event("escrowDispute", "buyer", "d".repeat(64)), event("resolve", "arbiter", "e".repeat(64))],
    });
    expect(status(html)).toBe("Settled by the arbiter: all to you, less 0.3%.");
    expect(html).toContain("✓ settled by the arbiter");
    expect(html).toContain("The arbiter settled the dispute: all to the seller, less 0.3%.");
    expect(html).toContain("Resolve receipt");
  });

  it("leaves the claimable room as it was", () => {
    const html = room({ ...trade, mode: "claimable", asset: "XLM", windowSeconds: 259_200 });
    expect(status(html)).toBe("Agreed. Lock when you're both at the meeting point.");
    expect(html).toContain("· window 72 h");
    expect(html).toContain("claimable balance");
    expect(html).not.toContain("Trustless Work");
  });
});
