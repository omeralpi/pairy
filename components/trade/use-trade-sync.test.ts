import { describe, expect, it } from "vitest";

import { CANCEL_LOCK_GRACE_MS, needsSync } from "./use-trade-sync";

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
