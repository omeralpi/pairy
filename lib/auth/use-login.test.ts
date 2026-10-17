import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

// useLogin only wires hooks together, so it runs as a plain function once the
// hooks it calls are stubbed. The query cache is a real one.
const queryClient = new QueryClient();
const mutation = () => ({ mutateAsync: vi.fn(async () => ({})), isPending: false });

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => queryClient,
}));
vi.mock("@/lib/api", () => ({
  api: {
    useUtils: () => ({ auth: { me: { invalidate: (filters?: unknown) => queryClient.invalidateQueries(filters as never) } } }),
    auth: { challenge: { useMutation: mutation }, verify: { useMutation: mutation }, logout: { useMutation: mutation } },
  },
}));
vi.mock("@/lib/wallet/use-wallet", () => ({ useWalletContext: () => ({ signMessage: vi.fn() }) }));

const { useLogin } = await import("./use-login");

describe("useLogin", () => {
  it("forgets the account's cached trades and chat on logout, so the next person on this tab never sees them", async () => {
    const trades = [[["trade", "mine"], { type: "query" }], [{ id: "t1", buyer: "GPEER" }]] as const;
    const chat = [[["chat", "list"], { input: { tradeId: "t1" }, type: "query" }], [{ body: "Meet at the station" }]] as const;
    queryClient.setQueryData(trades[0], trades[1]);
    queryClient.setQueryData(chat[0], chat[1]);

    await useLogin().logout();

    expect(queryClient.getQueryData(trades[0])).toBeUndefined();
    expect(queryClient.getQueryData(chat[0])).toBeUndefined();
  });
});
