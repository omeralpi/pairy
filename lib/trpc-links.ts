// How the browser talks to /api/trpc. Queries are batched (at most 10 per
// request, the server's limit), except trade.claimWindow: its serverNow is
// read against the time the answer arrives, and in a batch the answer waits
// for the slowest call in it (often a Horizon lookup), which would put the
// corrected clock seconds behind the server's.

import { httpBatchLink, httpLink, splitLink } from "@trpc/client";
import superjson from "superjson";

import type { AppRouter } from "@/server/api/root";

export const UNBATCHED_PATHS = new Set(["trade.claimWindow"]);

/** `fetch` is for tests; the browser's own is used otherwise. */
export function trpcLinks(fetch?: Parameters<typeof httpLink>[0]["fetch"]) {
  const url = "/api/trpc";
  return [
    splitLink<AppRouter>({
      condition: (op) => UNBATCHED_PATHS.has(op.path),
      true: httpLink({ url, transformer: superjson, fetch }),
      false: httpBatchLink({ url, transformer: superjson, maxItems: 10, fetch }),
    }),
  ];
}
