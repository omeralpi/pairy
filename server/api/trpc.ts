import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { SESSION_COOKIE, loadSession, readCookie } from "@/lib/auth/session";
import { db as defaultDb, type Db } from "@/lib/db";
import type { TestDb } from "@/lib/db/test-setup";

/** sessionId is absent only in tests that build a context by hand. */
export type Session = { publicKey: string; sessionId?: string } | null;

export type Context = {
  db: Db | TestDb;
  session: Session;
  /** Response headers; the auth router sets the session cookie here. */
  resHeaders: Headers;
};

export async function createTRPCContext(opts: {
  req: Request;
  resHeaders: Headers;
}): Promise<Context> {
  const token = readCookie(opts.req.headers.get("cookie"), SESSION_COOKIE);
  return {
    db: defaultDb,
    session: await loadSession(defaultDb, token),
    resHeaders: opts.resHeaders,
  };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    // An unexpected error's message can carry SQL or Horizon internals; only
    // messages written for the user (every TRPCError we throw) go out as is.
    const hidden = error.code === "INTERNAL_SERVER_ERROR" && process.env.NODE_ENV === "production";
    return {
      ...shape,
      message: hidden ? "Something went wrong. Please try again." : shape.message,
      data: {
        ...shape.data,
        stack: hidden ? undefined : shape.data.stack,
        zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;

/** Used in tests to invoke procedures directly against a constructed ctx. */
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, session: ctx.session } });
});
