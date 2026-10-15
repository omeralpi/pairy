// Stateless session cookie: `<publicKey>.<expiresAtMs>.<hmac>`. It proves the
// holder signed a login challenge with that Stellar key (see the auth router).
// It is not a Stellar key and grants no on-chain power.

import { createHmac, timingSafeEqual } from "node:crypto";

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

export function createSessionToken(publicKey: string, now = Date.now()): string {
  const payload = `${publicKey}.${now + SESSION_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

/** The public key the token was issued to, or null if invalid or expired. */
export function readSessionToken(token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [publicKey, expiresAt, mac] = parts;
  const expected = Buffer.from(sign(`${publicKey}.${expiresAt}`));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(expiresAt) < now) return null;
  return publicKey;
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
