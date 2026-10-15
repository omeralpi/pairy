// Login by proving control of a Stellar key, with no secret reaching the
// server: the wallet SEP-53-signs a one-time challenge on the user's device
// and only the public key, the nonce and the signature come back.

import { randomBytes } from "node:crypto";

import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { TRPCError } from "@trpc/server";
import { and, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { clearSessionCookieHeader, createSessionToken, sessionCookieHeader } from "@/lib/auth/session";
import { authChallenges, users } from "@/lib/db/schema";
import { createTRPCRouter, publicProcedure } from "@/server/api/trpc";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const publicKey = z.string().refine((s) => StrKey.isValidEd25519PublicKey(s), "Not a Stellar public key");

/** The exact text the wallet signs. Rebuilt server-side from the stored row on verify. */
export function challengeMessage(pk: string, nonce: string, expiresAt: Date): string {
  return [
    "Sign in to Pairy (Stellar testnet).",
    "This proves you control this account. It is not a transaction and moves no funds.",
    "",
    `Account: ${pk}`,
    `Nonce: ${nonce}`,
    `Expires: ${expiresAt.toISOString()}`,
  ].join("\n");
}

const unauthorized = (message: string) => new TRPCError({ code: "UNAUTHORIZED", message });

export const authRouter = createTRPCRouter({
  challenge: publicProcedure.input(z.object({ publicKey })).mutation(async ({ ctx, input }) => {
    const now = new Date();
    await ctx.db.delete(authChallenges).where(lt(authChallenges.expiresAt, now));

    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
    await ctx.db.insert(authChallenges).values({ nonce, publicKey: input.publicKey, expiresAt });
    return { nonce, message: challengeMessage(input.publicKey, nonce, expiresAt) };
  }),

  verify: publicProcedure
    .input(
      z.object({
        publicKey,
        nonce: z.string().min(1).max(100),
        /** Base64 64-byte ed25519 signature over the SEP-53 hash of the message. */
        signature: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Consume first: whatever happens next, this nonce can never be used again.
      const [row] = await ctx.db
        .delete(authChallenges)
        .where(and(eq(authChallenges.nonce, input.nonce), eq(authChallenges.publicKey, input.publicKey)))
        .returning();
      if (!row) throw unauthorized("Unknown or already used challenge.");
      if (row.expiresAt.getTime() < Date.now()) throw unauthorized("Challenge expired. Try again.");

      const message = challengeMessage(row.publicKey, row.nonce, row.expiresAt);
      const ok = Keypair.fromPublicKey(row.publicKey).verifyMessage(message, Buffer.from(input.signature, "base64"));
      if (!ok) throw unauthorized("Signature does not match this account.");

      await ctx.db.insert(users).values({ publicKey: row.publicKey }).onConflictDoNothing();
      ctx.resHeaders.append("Set-Cookie", sessionCookieHeader(createSessionToken(row.publicKey)));
      return { publicKey: row.publicKey };
    }),

  me: publicProcedure.query(({ ctx }) => (ctx.session ? { publicKey: ctx.session.publicKey } : null)),

  logout: publicProcedure.mutation(({ ctx }) => {
    ctx.resHeaders.append("Set-Cookie", clearSessionCookieHeader());
    return { ok: true };
  }),
});
