import { describe, expect, it } from "vitest";

import { GET, POST } from "@/app/api/trpc/[trpc]/route";

// The HTTP route itself (the callers in the router tests skip it).
const url = (path: string, query = "") => `http://localhost/api/trpc/${path}${query}`;
const search = (n: number) =>
  url(
    Array(n).fill("geo.searchCities").join(","),
    `?batch=1&input=${encodeURIComponent(JSON.stringify(Object.fromEntries(Array.from({ length: n }, (_, i) => [i, { json: { q: "ist" } }]))))}`,
  );

describe("/api/trpc route", () => {
  it("sends Cache-Control: no-store", async () => {
    const res = await GET(new Request(search(1)));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts a batch of 10 calls and rejects 11 with a 400", async () => {
    expect((await GET(new Request(search(10)))).status).toBe(200);
    const res = await GET(new Request(search(11)));
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects a body over 64 KB with a 413 before reading it", async () => {
    const body = JSON.stringify({ 0: { json: { tradeId: "x", body: "x".repeat(64 * 1024) } } });
    const res = await POST(
      new Request(url("chat.send", "?batch=1"), {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(body.length) },
        body,
      }),
    );
    expect(res.status).toBe(413);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("also caps a streamed body that has no Content-Length", async () => {
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    let sent = 0;
    const body = new ReadableStream({
      pull(c) {
        if (sent++ < 128) c.enqueue(chunk); // 2 MB in total
        else c.close();
      },
    });
    const req = new Request(url("chat.send", "?batch=1"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await POST(req);
    expect(res.status).toBe(413);
    // It stopped reading soon after the cap instead of buffering all 2 MB.
    expect(sent).toBeLessThan(10);
  });

  it("still serves a small streamed body", async () => {
    const req = new Request(url("auth.challenge"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify({ json: { publicKey: "not-a-key" } })));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    // Reaches the procedure, whose input check then refuses the key.
    expect((await POST(req)).status).toBe(400);
  });
});
