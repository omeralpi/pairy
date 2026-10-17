import { createTRPCClient } from "@trpc/client";
import { describe, expect, it } from "vitest";

import type { AppRouter } from "@/server/api/root";

import { trpcLinks } from "./trpc-links";

describe("trpcLinks (F3)", () => {
  it("sends claimWindow on its own, so its serverNow is not delayed by a batch", async () => {
    const urls: string[] = [];
    const fetch = async (url: unknown) => {
      urls.push(String(url));
      return new Response("{}", { status: 500 });
    };
    const client = createTRPCClient<AppRouter>({ links: trpcLinks(fetch as never) });
    const id = "5b0c9a52-1f7e-4c1b-9d0e-2a4f6b8c0d1e";
    await Promise.allSettled([
      client.trade.claimWindow.query({ tradeId: id }),
      client.trade.byId.query({ id }),
      client.trade.lockPreflight.query({ tradeId: id }),
    ]);
    const claim = urls.filter((u) => u.includes("trade.claimWindow"));
    expect(claim).toHaveLength(1);
    expect(claim[0]).not.toMatch(/batch=1|trade\.byId|trade\.lockPreflight/);
    expect(urls.some((u) => u.includes("trade.byId,trade.lockPreflight") && u.includes("batch=1"))).toBe(true);
  });
});
