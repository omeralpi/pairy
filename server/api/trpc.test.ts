import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCError } from "@trpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTRPCRouter, publicProcedure } from "./trpc";

vi.mock("@/lib/db", () => ({ db: {} }));

const router = createTRPCRouter({
  crash: publicProcedure.query(() => {
    throw new Error('Failed query: select "secret_column" from "trades"');
  }),
  refuse: publicProcedure.query(() => {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This listing is not available" });
  }),
});

async function call(path: string) {
  const res = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req: new Request(`http://localhost/api/trpc/${path}`),
    router,
    createContext: () => ({ db: {} as never, session: null, resHeaders: new Headers() }),
  });
  return JSON.stringify(await res.json());
}

afterEach(() => vi.unstubAllEnvs());

describe("error responses (T-5)", () => {
  it("hide internal error details in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const body = await call("crash");
    expect(body).not.toMatch(/secret_column|Failed query/);
    expect(body).toMatch(/Something went wrong/);
  });

  it("keep messages written for the user", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(await call("refuse")).toMatch(/This listing is not available/);
  });
});
