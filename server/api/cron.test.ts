import { afterEach, describe, expect, it, vi } from "vitest";

import { expireIdleTrades } from "@/lib/trade/expire";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/trade/expire", () => ({ expireIdleTrades: vi.fn(async () => ({ expired: 0, skipped: 0, purged: 0 })) }));

const { GET } = await import("@/app/api/cron/expire-trades/route");
const call = (auth?: string) =>
  GET(new Request("http://localhost/api/cron/expire-trades", { headers: auth ? { authorization: auth } : {} }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(expireIdleTrades).mockClear();
});

describe("/api/cron/expire-trades", () => {
  it("runs only for Vercel Cron's bearer secret", async () => {
    vi.stubEnv("CRON_SECRET", "s".repeat(32));
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call(`Bearer ${"t".repeat(32)}`)).status).toBe(401); // right length, wrong secret
    expect(expireIdleTrades).not.toHaveBeenCalled();
    const ok = await call(`Bearer ${"s".repeat(32)}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ expired: 0, skipped: 0, purged: 0 });
  });

  it("refuses every call when no secret is configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer ")).status).toBe(401);
    expect((await call("Bearer undefined")).status).toBe(401);
    expect(expireIdleTrades).not.toHaveBeenCalled();
  });
});
