import { createHash } from "node:crypto";

import { Keypair } from "@stellar/stellar-sdk";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { readSessionToken } from "@/lib/auth/session";
import { authChallenges, users } from "@/lib/db/schema";
import { createTestDb, type TestDb } from "@/lib/db/test-setup";
import { createCallerFactory } from "@/server/api/trpc";

import { authRouter, challengeMessage } from "./auth";

const createCaller = createCallerFactory(authRouter);
let db: TestDb;
const caller = (session: { publicKey: string } | null = null, resHeaders = new Headers()) =>
  createCaller({ db, session, resHeaders });

const sign = (kp: Keypair, message: string) => Buffer.from(kp.signMessage(message)).toString("base64");

beforeEach(async () => {
  ({ db } = await createTestDb());
});

describe("auth", () => {
  it("logs in with a SEP-53 signature, sets the cookie and creates the user", async () => {
    const kp = Keypair.random();
    const { nonce, message } = await caller().challenge({ publicKey: kp.publicKey() });
    expect(message).toContain(kp.publicKey());

    const resHeaders = new Headers();
    const res = await caller(null, resHeaders).verify({ publicKey: kp.publicKey(), nonce, signature: sign(kp, message) });
    expect(res).toEqual({ publicKey: kp.publicKey() });

    const cookie = resHeaders.get("set-cookie")!;
    const token = /pairy_session=([^;]+)/.exec(cookie)![1];
    expect(readSessionToken(token)).toBe(kp.publicKey());
    expect(await db.select().from(users).where(eq(users.publicKey, kp.publicKey()))).toHaveLength(1);
    expect(await db.select().from(authChallenges)).toHaveLength(0);
  });

  it("accepts Freighter's signMessage output (SEP-53 digest, base64 signature)", async () => {
    // Mirrors stellar/freighter extension/src/helpers/stellar.ts encodeSep53Message
    // + handlers/signBlob.ts + freighterApiMessageListener.ts (apiVersion >= 4).
    const kp = Keypair.random();
    const { nonce, message } = await caller().challenge({ publicKey: kp.publicKey() });
    const digest = createHash("sha256")
      .update(Buffer.concat([Buffer.from("Stellar Signed Message:\n", "utf8"), Buffer.from(message, "utf8")]))
      .digest();
    const signature = Buffer.from(kp.sign(digest)).toString("base64");
    expect(await caller().verify({ publicKey: kp.publicKey(), nonce, signature })).toEqual({ publicKey: kp.publicKey() });
  });

  it("rejects a replayed nonce", async () => {
    const kp = Keypair.random();
    const { nonce, message } = await caller().challenge({ publicKey: kp.publicKey() });
    const input = { publicKey: kp.publicKey(), nonce, signature: sign(kp, message) };
    await caller().verify(input);
    await expect(caller().verify(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a signature from another key, and burns the nonce", async () => {
    const kp = Keypair.random();
    const { nonce, message } = await caller().challenge({ publicKey: kp.publicKey() });
    const resHeaders = new Headers();
    await expect(
      caller(null, resHeaders).verify({ publicKey: kp.publicKey(), nonce, signature: sign(Keypair.random(), message) }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: expect.stringMatching(/Signature/) });
    expect(resHeaders.get("set-cookie")).toBeNull();
    await expect(
      caller().verify({ publicKey: kp.publicKey(), nonce, signature: sign(kp, message) }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects a nonce issued to a different public key", async () => {
    const kp = Keypair.random();
    const other = Keypair.random();
    const { nonce, message } = await caller().challenge({ publicKey: kp.publicKey() });
    await expect(
      caller().verify({ publicKey: other.publicKey(), nonce, signature: sign(other, message) }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an expired nonce", async () => {
    const kp = Keypair.random();
    const { nonce } = await caller().challenge({ publicKey: kp.publicKey() });
    const past = new Date(Date.now() - 1000);
    await db.update(authChallenges).set({ expiresAt: past }).where(eq(authChallenges.nonce, nonce));
    await expect(
      caller().verify({ publicKey: kp.publicKey(), nonce, signature: sign(kp, challengeMessage(kp.publicKey(), nonce, past)) }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", message: expect.stringMatching(/expired/) });
  });

  it("me reflects the session; logout clears the cookie", async () => {
    expect(await caller().me()).toBeNull();
    expect(await caller({ publicKey: "GABC" }).me()).toEqual({ publicKey: "GABC" });
    const resHeaders = new Headers();
    await caller({ publicKey: "GABC" }, resHeaders).logout();
    expect(resHeaders.get("set-cookie")).toMatch(/pairy_session=;.*Max-Age=0/);
  });
});
