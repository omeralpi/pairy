// The Trustless Work client against the responses WP-03 recorded on testnet
// (tests/fixtures/tw). fetch is mocked in every test: CI has no API key and
// never reaches the network.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { TRPCError } from "@trpc/server";
import { ZodError } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TW_API_BASE } from "@/lib/escrow/config";

import { TW_ENDPOINTS, TwApiError, twAmount, twCall, type TwEndpoint } from "./client";

type Recorded = {
  endpoint: string;
  request: { method: string; path: string; body: unknown };
  response: { status: number; body: unknown };
};

const FIXTURES = path.join(process.cwd(), "tests/fixtures/tw");
const load = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

/** Recorded by WP-03 for the findings, but Pairy never calls these paths. */
const NOT_CALLED = ["escrow-balances-b.json", "escrow-balances.json", "get-escrow-b.json", "get-escrow.json"];
/** Prepared only; its unsignedXdr was left out of the recording. */
const TRIMMED = ["deploy-reused-engagement-id.json"];

const recorded: [string, Recorded][] = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json") && f !== "errors.json")
  .sort()
  .map((f) => [f, load(f)]);
const probes: [string, Recorded][] = [
  ...Object.entries(load("errors.json").probes as Record<string, Recorded>),
  ["resolve-dispute-wrong-sum", load("resolve-dispute-wrong-sum.json")],
];

/** The allowlisted endpoint a recorded request was sent to, if any. */
function endpointOf(r: Recorded): TwEndpoint | undefined {
  return (Object.keys(TW_ENDPOINTS) as TwEndpoint[]).find((ep) => {
    const { method, path: p } = TW_ENDPOINTS[ep];
    return method === r.request.method && new RegExp(`^${p.replace("{contractId}", "C[A-Z2-7]{55}")}$`).test(r.request.path);
  });
}

/** A request body Trustless Work accepted, per endpoint. */
const ACCEPTED = {
  deploy: load("deploy.json").request.body,
  fund: load("fund.json").request.body,
  approveAndRelease: load("approve-and-release-milestones.json").request.body,
  dispute: load("dispute.json").request.body,
  resolve: load("resolve-dispute.json").request.body,
  submit: load("send-transaction-call.json").request.body,
  read: { contractId: "CCGML7GRKDX42ZYSSXSQYXU7Q5HQ3A6O2SZZPLOYVJY6CROAJHVRYAUN" },
};

const KEY = "test.not-a-trustless-work-key";
const RETRY = "Trustless Work isn't answering right now. Nothing was signed; try again in a minute.";

const fetchMock = vi.fn<typeof fetch>();
const answer = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
const sent = () => {
  const [url, init] = fetchMock.mock.calls[0];
  return { url, init: init as RequestInit, headers: new Headers((init as RequestInit).headers) };
};
const failure = (p: Promise<unknown>) => p.then(() => expect.unreachable("resolved"), (e: unknown) => e);

beforeEach(() => {
  vi.stubEnv("TRUSTLESS_WORK_API_KEY", KEY);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => {
    throw new Error("unexpected network call");
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the recorded Trustless Work calls", () => {
  it("each went to an allowlisted endpoint, except the reads Pairy never makes", () => {
    const unmatched = recorded.filter(([, r]) => !endpointOf(r)).map(([f]) => f);
    expect(unmatched).toEqual(NOT_CALLED);
    for (const [f, r] of recorded) if (!NOT_CALLED.includes(f)) expect(endpointOf(r), f).toBe(r.endpoint);
  });

  const successes = recorded.filter(
    ([f, r]) => !NOT_CALLED.includes(f) && !TRIMMED.includes(f) && r.response.status === 200,
  );

  it.each(successes)("%s: the client sends the recorded request and parses the recorded answer", async (_, r) => {
    const ep = endpointOf(r)!;
    answer(r.response.status, r.response.body);
    const out = await twCall(ep, (r.request.body ?? { contractId: r.request.path.split("/").pop() }) as never, {});

    const { url, init, headers } = sent();
    expect(url).toBe(TW_API_BASE + r.request.path);
    expect(init.method).toBe(r.request.method);
    expect(headers.get("x-api-key")).toBe(KEY);
    if (r.request.method === "POST") {
      expect(JSON.parse(init.body as string)).toEqual(r.request.body);
      expect(headers.get("content-type")).toBe("application/json");
    } else {
      expect(init.body).toBeUndefined();
    }
    expect(r.response.body).toMatchObject(out as object);
    if (!["submit", "read"].includes(ep)) expect(out).toEqual(r.response.body);
  });

  it.each(probes)("%s: a refusal becomes a TwApiError with its status, code and detail", async (_, probe) => {
    const ep = endpointOf(probe)!;
    const problem = probe.response.body as { status: number; code: string; detail: string };
    answer(probe.response.status, problem);
    const err = await failure(twCall(ep, ACCEPTED[ep] as never, {}));
    expect(err).toBeInstanceOf(TwApiError);
    expect(err).toMatchObject({ endpoint: ep, status: problem.status, code: problem.code, detail: problem.detail });
    expect((err as Error).message).toBe(problem.detail);
  });

  it("refuses, before sending, the bodies Trustless Work refused for their shape", async () => {
    const byName = Object.fromEntries(probes);
    for (const name of ["missingField", "unknownProperty"]) {
      await expect(twCall("fund", byName[name].request.body as never, {})).rejects.toBeInstanceOf(ZodError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("twCall", () => {
  it("refuses to run without an API key, and calls nobody", async () => {
    for (const unset of ["", "   "]) {
      vi.stubEnv("TRUSTLESS_WORK_API_KEY", unset);
      const err = await failure(twCall("fund", ACCEPTED.fund, {}));
      expect(err).toBeInstanceOf(TRPCError);
      expect(err).toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: "Protected trades are not configured" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails loudly when an answer has an unknown shape", async () => {
    const deploy = load("deploy.json").response.body;
    const cases: [TwEndpoint, unknown][] = [
      ["fund", {}],
      ["fund", "<html>maintenance</html>"],
      ["fund", { unsignedXdr: "AAAA", txHash: "not-a-hash" }],
      ["deploy", { unsignedXdr: deploy.unsignedXdr, txHash: deploy.txHash }], // no contractId
      ["deploy", { ...deploy, contractId: "GBMIVYQOGG7M5Z43RKXDFC5AZPBPJOM4VHIL2LZXW6N2GCVC7NUY3NR4" }],
      ["read", { escrow: null }],
    ];
    for (const [ep, body] of cases) {
      answer(200, body);
      const err = await failure(twCall(ep, ACCEPTED[ep] as never, {}));
      expect(err, JSON.stringify(body)).toBeInstanceOf(TwApiError);
      expect(err).toMatchObject({ endpoint: ep, status: 200, code: undefined });
      expect((err as Error).message).toMatch(/unexpected/);
    }
  });

  it("gives the retry sentence when Trustless Work is down, slow or unreachable", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    answer(503, { status: 503, code: "SERVICE_UNAVAILABLE", detail: "Upstream RPC down" });
    expect(await failure(twCall("fund", ACCEPTED.fund, {}))).toMatchObject({
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      message: RETRY,
    });
    answer(502, "<html>Bad gateway</html>");
    expect(await failure(twCall("fund", ACCEPTED.fund, {}))).toMatchObject({ status: 502, code: undefined, message: RETRY });
    fetchMock.mockRejectedValueOnce(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expect(await failure(twCall("fund", ACCEPTED.fund, {}))).toMatchObject({ status: 0, message: RETRY });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const err = await failure(twCall("fund", ACCEPTED.fund, {}));
    expect(err).toBeInstanceOf(TwApiError);
    expect(err).toMatchObject({ endpoint: "fund", status: 0, message: RETRY });
    expect(timeout).toHaveBeenCalledTimes(4);
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(fetchMock.mock.calls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true);
  });

  it("names the status when a refusal has no problem document", async () => {
    answer(404, "Not Found");
    expect(await failure(twCall("read", ACCEPTED.read, {}))).toMatchObject({
      status: 404,
      code: undefined,
      message: "Trustless Work refused the request (HTTP 404).",
    });
  });

  it("fills the read path only from a valid contract address", async () => {
    for (const contractId of ["../users/me", "GBMIVYQOGG7M5Z43RKXDFC5AZPBPJOM4VHIL2LZXW6N2GCVC7NUY3NR4", "C?x=1"]) {
      await expect(twCall("read", { contractId }, {})).rejects.toBeInstanceOf(ZodError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses amounts that are not plain decimal numbers, and anything outside the allowlist", async () => {
    for (const amount of ["10", 0, -1, 0.1 + 0.2, Number.NaN]) {
      await expect(twCall("fund", { ...ACCEPTED.fund, amount } as never, {})).rejects.toBeInstanceOf(ZodError);
    }
    await expect(twCall("updateEscrow" as TwEndpoint, ACCEPTED.fund as never, {})).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs one line per call with no key, header or body, and never puts the key in an error", async () => {
    const log = vi.mocked(console.log);
    const deploy = load("deploy.json").response.body;
    answer(200, deploy);
    await twCall("deploy", ACCEPTED.deploy, { tradeId: "trade-1" });
    answer(409, load("errors.json").probes.resolveWhileNotDisputed.response.body);
    const err = await failure(twCall("resolve", ACCEPTED.resolve, {}));

    expect(log.mock.calls.map((c) => JSON.parse(c[0]))).toEqual([
      { evt: "tw", ep: "deploy", status: 200, ms: expect.any(Number), tradeId: "trade-1" },
      { evt: "tw", ep: "resolve", status: 409, ms: expect.any(Number) },
    ]);
    const logged = JSON.stringify(log.mock.calls);
    for (const leak of [KEY, "x-api-key", deploy.unsignedXdr.slice(0, 40), ACCEPTED.deploy.engagementId]) {
      expect(logged).not.toContain(leak);
    }
    expect(JSON.stringify({ ...(err as object), message: (err as Error).message })).not.toContain(KEY);
  });
});

describe("twAmount", () => {
  it("turns stroops into the decimal number Trustless Work expects", () => {
    expect(twAmount(123_456_789n)).toBe(12.3456789);
    expect(twAmount(100_000_000n)).toBe(10);
    expect(twAmount(1n)).toBe(0.0000001);
    expect(twAmount(9_007_199_254_740_993n)).toBe(900719925.4740993);
  });

  it("throws when a double cannot carry the amount exactly", () => {
    expect(() => twAmount(922_337_203_685_477_580n)).toThrow();
    expect(() => twAmount(-1n)).toThrow();
  });
});
