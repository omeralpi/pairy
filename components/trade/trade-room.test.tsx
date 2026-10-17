import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The trade room as it renders for one byId result; every other query is
// still loading. No browser: the markup is enough to see what is on screen.
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
const trade = {
  id,
  listingId: "22222222-2222-4222-8222-222222222222",
  state: "agreed",
  role: "seller",
  openedBy: "buyer",
  seller: "GSELLER",
  buyer: "GBUYER",
  counterparty: "GBUYER",
  counterpartyUrl: "https://stellar.expert/explorer/testnet/account/GBUYER",
  asset: "XLM",
  amount: "12.5000000",
  fiatAmount: "50.00",
  fiatCode: "EUR",
  rate: "4.0000",
  cityName: "Berlin",
  windowSeconds: 259_200,
  disputed: false,
  balanceId: null,
  lockTx: null,
  claimTx: null,
  reclaimTx: null,
  events: [],
};
const failed = { message: "Something went wrong. Please try again.", data: { code: "INTERNAL_SERVER_ERROR" } };

describe("TradeRoom when a refresh fails", () => {
  it("gets the trade and the error together from React Query after a failed refresh", async () => {
    let calls = 0;
    const observer = new QueryObserver(new QueryClient(), {
      queryKey: ["byId"],
      queryFn: async () => {
        if (calls++) throw new Error("Failed to fetch");
        return trade;
      },
      retry: false,
    });
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    await observer.refetch();
    const r = observer.getCurrentResult();
    stop();
    expect(r.data).toBe(trade);
    expect(r.error?.message).toBe("Failed to fetch");
  });

  it("keeps the trade, and the lock screen the seller may be signing on, when one 5 s refresh fails", () => {
    // React Query keeps the last trade it read next to the refresh's error.
    byId.result = { data: trade, error: failed, isLoading: false };
    const html = renderToStaticMarkup(<TradeRoom id={id} />);
    expect(html).toContain("LOCK PANEL");
    expect(html).not.toContain("Something went wrong");
  });

  it("still shows the error when the trade was never read", () => {
    byId.result = { data: undefined, error: failed, isLoading: false };
    const html = renderToStaticMarkup(<TradeRoom id={id} />);
    expect(html).toContain("Something went wrong. Please try again.");
    expect(html).not.toContain("LOCK PANEL");
  });
});
