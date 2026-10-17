import { timingSafeEqual } from "node:crypto";

import { db } from "@/lib/db";
import { expireIdleTrades } from "@/lib/trade/expire";

// Daily cleanup, called by Vercel Cron (vercel.json) with
// "Authorization: Bearer $CRON_SECRET". It takes no input. Without a
// CRON_SECRET of at least 32 characters every call is refused.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (secret.length < 32) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return new Response("Unauthorized", { status: 401, headers: { "cache-control": "no-store" } });
  }
  return Response.json(await expireIdleTrades(db), { headers: { "cache-control": "no-store" } });
}
