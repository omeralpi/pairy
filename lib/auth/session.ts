// Session cookie: `<publicKey>.<expiresAtMs>.<sessionId>.<hmac>`. It proves the
// holder signed a login challenge with that Stellar key (see the auth router).
// It is not a Stellar key and grants no on-chain power. The HMAC rejects forged
// cookies without a query; the sessions row makes logout final.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import type { Db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import type { TestDb } from "@/lib/db/test-setup";

type Database = Db | TestDb;

export const SESSION_COOKIE = "pairy_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters");
  }
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** Stores a new session and returns its cookie token. */
export async function createSession(db: Database, publicKey: string, now = Date.now()): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;
  await db.insert(sessions).values({ id, publicKey, expiresAt: new Date(expiresAt) });
  const payload = `${publicKey}.${expiresAt}.${id}`;
  return `${payload}.${sign(payload)}`;
}

/** What the token claims, or null if it is forged or expired. Does not check revocation. */
export function readSessionToken(
  token: string | undefined,
  now = Date.now(),
): { publicKey: string; sessionId: string } | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [publicKey, expiresAt, sessionId, mac] = parts;
  const expected = Buffer.from(sign(`${publicKey}.${expiresAt}.${sessionId}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(expiresAt) < now) return null;
  return { publicKey, sessionId };
}

/** The session behind a cookie token, or null if invalid, expired or logged out. */
export async function loadSession(
  db: Database,
  token: string | undefined,
): Promise<{ publicKey: string; sessionId: string } | null> {
  const claimed = readSessionToken(token);
  if (!claimed) return null;
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.id, claimed.sessionId),
        eq(sessions.publicKey, claimed.publicKey),
        gt(sessions.expiresAt, new Date()),
      ),
    );
  return row ? claimed : null;
}

export function sessionCookieHeader(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}
