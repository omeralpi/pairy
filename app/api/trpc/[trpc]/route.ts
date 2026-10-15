import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";

// The only API surface Pairy has. tests/ci/no-secret-fields asserts that no
// input on it accepts a secret key or pincode, and that no other route exists.
const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: ({ resHeaders }) => createTRPCContext({ req, resHeaders }),
  });

export { handler as GET, handler as POST };
