import { afterEach, describe, expect, it, vi } from "vitest";

import { readPendingTx, savePendingTx } from "@/lib/trade/pending-tx";

// For useTradeSync itself: React's useEffect is captured instead of
// scheduled, so a test runs the effect by hand, and every tRPC call is a
// stub that records what it was asked.
const effects = vi.hoisted(() => [] as (() => void | (() => void))[]);
const calls = vi.hoisted(() => [] as { path: string; input: unknown }[]);
const byId = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (fn: () => void | (() => void)) => void effects.push(fn),
}));
vi.mock("@/lib/api", () => {
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_, key: string) => {
        if (key === "useMutation") {
          return () => ({ mutateAsync: async (input: unknown) => void calls.push({ path: path.join("."), input }) });
        }
        if (key === "useUtils") return () => node([]);
        if (key === "getData") return () => byId.data;
        if (key === "invalidate") return async () => {};
        return node([...path, key]);
      },
    });
  return { api: node([]) };
});

const { CANCEL_LOCK_GRACE_MS, needsSync, useTradeSync } = await import("./use-trade-sync");

const at = new Date(1_800_000_000_000);
const ev = (type: string) => ({ type, createdAt: at });

describe("needsSync", () => {
  it("skips a trade cancelled before it was agreed", () => {
    expect(needsSync({ state: "cancelled", balanceId: null, events: [ev("open"), ev("cancel")] } as never, +at)).toBe(false);
    expect(needsSync({ state: "agreed", balanceId: null, events: [] } as never)).toBe(true);
    expect(needsSync({ state: "claimed", balanceId: "x", events: [] } as never)).toBe(false);
  });

  it("stops looking for a racing lock once the server's grace period after the cancel is over (F9)", () => {
    const t = { state: "cancelled", balanceId: null, events: [ev("open"), ev("agree"), ev("cancel")] } as never;
    expect(needsSync(t, +at + CANCEL_LOCK_GRACE_MS - 1)).toBe(true);
    expect(needsSync(t, +at + CANCEL_LOCK_GRACE_MS)).toBe(false);
  });

  it("treats an automatic expiry like a cancel", () => {
    const t = { state: "cancelled", balanceId: null, events: [ev("open"), ev("agree"), ev("expire")] } as never;
    expect(needsSync(t, +at + CANCEL_LOCK_GRACE_MS - 1)).toBe(true);
    expect(needsSync(t, +at + CANCEL_LOCK_GRACE_MS)).toBe(false);
  });

  it("keeps reporting a lock hash this browser holds after the grace period (round 2 F5)", () => {
    const t = { state: "cancelled", balanceId: null, events: [ev("open"), ev("agree"), ev("cancel")] } as never;
    expect(needsSync(t, +at + CANCEL_LOCK_GRACE_MS * 10, true)).toBe(true);
    expect(needsSync(t, +at + CANCEL_LOCK_GRACE_MS * 10, false)).toBe(false);
  });

  it("matches the server's grace period", async () => {
    const server = await import("@/lib/trade/sync");
    expect(CANCEL_LOCK_GRACE_MS).toBe(server.CANCEL_LOCK_GRACE_MS);
  });
});

describe("needsSync for a protected trade (WP-34)", () => {
  const p = (state: string, escrowAdmin: string | null = null) =>
    ({ mode: "protected", state, balanceId: null, escrowAdmin, events: [] }) as never;

  it("looks for an escrow creation only once a one-time key was handed to Trustless Work", () => {
    expect(needsSync(p("agreed"))).toBe(false);
    expect(needsSync(p("agreed", "GADMIN"))).toBe(true);
  });

  it("keeps a created or funded escrow in line with the chain, and stops once it is settled", () => {
    expect(needsSync(p("escrow_created", "GADMIN"))).toBe(true);
    expect(needsSync(p("funded", "GADMIN"))).toBe(true);
    for (const state of ["listed", "released", "resolved_buyer", "resolved_seller"]) expect(needsSync(p(state, "GADMIN"))).toBe(false);
  });
});

describe("useTradeSync after a reload (WP-34)", () => {
  const ID = "11111111-1111-4111-8111-111111111111";
  const HASH = "ab".repeat(32);

  afterEach(() => {
    vi.unstubAllGlobals();
    effects.length = 0;
    calls.length = 0;
  });

  it("reports the escrow creation this browser sent through escrow.recordCreate, then syncs", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    const trade = {
      id: ID,
      mode: "protected",
      state: "agreed",
      escrowAdmin: "GADMIN",
      balanceId: null,
      lockTx: null,
      claimTx: null,
      reclaimTx: null,
      createTx: null,
      fundTx: null,
      releaseTx: null,
      events: [],
    };
    byId.data = trade;
    savePendingTx(ID, { kind: "create", hash: HASH });

    useTradeSync(trade as never);
    const stop = effects[0]();
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toContain("trade.sync"));
    if (typeof stop === "function") stop();

    expect(calls).toEqual([
      { path: "escrow.recordCreate", input: { tradeId: ID, txHash: HASH } },
      { path: "trade.sync", input: { tradeId: ID } },
    ]);
    expect(readPendingTx(ID)).toBeNull();
  });
});
