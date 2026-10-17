import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";

// No input is anywhere near this; chat messages are capped at 1000 chars.
const MAX_BODY_BYTES = 64 * 1024;

const tooLarge = () =>
  new Response("Request body too large", { status: 413, headers: { "cache-control": "no-store" } });

/** The body read up to the cap, or null once it goes over (reading stops there). */
async function readCapped(body: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

// The only API that takes input (the daily cleanup in app/api/cron takes
// none). tests/ci/no-secret-fields asserts that no input here accepts a secret
// key or pincode, and that no other route exists.
const handler = async (incoming: Request) => {
  let req = incoming;
  const length = req.headers.get("content-length");
  if (length !== null) {
    if (Number(length) > MAX_BODY_BYTES) return tooLarge();
  } else if (req.body) {
    // A streamed body has no length up front: count it while reading.
    const body = await readCapped(req.body);
    if (body === null) return tooLarge();
    req = new Request(req.url, { method: req.method, headers: req.headers, body });
  }
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    // Answered with a 400 before any procedure runs.
    maxBatchSize: 10,
    createContext: ({ resHeaders }) => createTRPCContext({ req, resHeaders }),
    // Responses reflect the session cookie; no cache may keep them.
    responseMeta: () => ({ headers: { "cache-control": "no-store" } }),
  });
};

export { handler as GET, handler as POST };
