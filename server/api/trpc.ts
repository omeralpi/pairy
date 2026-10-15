import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { ZodError } from "zod";

import { SESSION_COOKIE, readCookie, readSessionToken } from "@/lib/auth/session";
import { db as defaultDb, type Db } from "@/lib/db";
import type { TestDb } from "@/lib/db/test-setup";

export type Session = { publicKey: string } | null;

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
  const publicKey = readSessionToken(token);
  return {
    db: defaultDb,
    session: publicKey ? { publicKey } : null,
    resHeaders: opts.resHeaders,
  };
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
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
