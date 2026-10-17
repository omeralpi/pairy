// SOW D2: "Pairy's API has no field, on any endpoint, that accepts a secret key
// or a pincode, and a CI test named no-secret-fields fails the build if one is
// ever added." This walks every tRPC procedure's input schema, and checks that
// tRPC is the only way to send the server input at all.
//
// The walker fails closed: a schema it cannot see inside (any, unknown,
// records, passthrough objects, non-zod parsers) is reported, because it could
// carry a secret under any key.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

import type { AnyRouter } from "@trpc/server";
import { z, type ZodTypeAny } from "zod";
import { describe, expect, it } from "vitest";

import { appRouter } from "@/server/api/root";

const FORBIDDEN = /secret|seed|mnemonic|private|priv_?key|pin(code)?|passphrase|password/i;

/** Every problem found in `schema`, as "path: reason". */
function findSecretFields(schema: unknown, at = "input", seen = new Set<unknown>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);

  const def = (schema as ZodTypeAny | undefined)?._def as Record<string, any> | undefined;
  if (!def || typeof def.typeName !== "string") return [`${at}: not a zod (v3) schema, cannot inspect`];
  const walk = (s: unknown, p = at) => findSecretFields(s, p, seen);

  switch (def.typeName) {
    case "ZodObject": {
      const out: string[] = [];
      for (const [key, value] of Object.entries(def.shape() as Record<string, unknown>)) {
        if (FORBIDDEN.test(key)) out.push(`${at}.${key}: forbidden field name`);
        out.push(...walk(value, `${at}.${key}`));
      }
      if (def.unknownKeys === "passthrough") out.push(`${at}: passthrough object accepts any key`);
      if (def.catchall?._def?.typeName !== "ZodNever") out.push(...walk(def.catchall, `${at}.<catchall>`));
      return out;
    }
    case "ZodArray":
    case "ZodSet":
    case "ZodPromise":
      return walk(def.type ?? def.valueType, `${at}[]`);
    case "ZodTuple":
      return [...def.items.flatMap((s: unknown, i: number) => walk(s, `${at}[${i}]`)), ...(def.rest ? walk(def.rest, `${at}[...]`) : [])];
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
    case "ZodCatch":
    case "ZodReadonly":
      return walk(def.innerType);
    case "ZodBranded":
      return walk(def.type);
    case "ZodEffects":
      return walk(def.schema);
    case "ZodPipeline":
      return [...walk(def.in), ...walk(def.out)];
    case "ZodLazy":
      return walk(def.getter());
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return [...def.options].flatMap((s: unknown, i: number) => walk(s, `${at}|${i}`));
    case "ZodIntersection":
      return [...walk(def.left), ...walk(def.right)];
    case "ZodString":
    case "ZodNumber":
    case "ZodBigInt":
    case "ZodBoolean":
    case "ZodDate":
    case "ZodLiteral":
    case "ZodEnum":
    case "ZodNativeEnum":
    case "ZodNull":
    case "ZodUndefined":
    case "ZodVoid":
    case "ZodNaN":
    case "ZodNever":
      return [];
    default:
      // ZodAny, ZodUnknown, ZodRecord, ZodMap, ... accept arbitrary keys.
      return [`${at}: ${def.typeName} can carry arbitrary keys`];
  }
}

function procedureInputs(router: AnyRouter): { path: string; inputs: unknown[] }[] {
  return Object.entries(router._def.procedures as Record<string, { _def: { inputs: unknown[] } }>).map(
    ([p, proc]) => ({ path: p, inputs: proc._def.inputs }),
  );
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => path.join(dir, f).split(path.sep).join("/"))
    .filter((f) => !f.includes("/node_modules/"));
}

const root = process.cwd();
const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");

/**
 * What a route reads from its request beyond the Authorization header, and
 * any export other than a plain GET function. Comments are ignored.
 */
function routeInputProblems(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const problems: string[] = [];
  const exported = [...code.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/g)].map((m) => m[1]);
  if (exported.join() !== "GET") problems.push(`exports ${exported.join(", ") || "nothing"}, not just GET`);
  if (/export\s*(\{|default|\*)/.test(code)) problems.push("re-exports or default export");
  if (/export\s+const\s+GET/.test(code)) problems.push("GET must be a plain function declaration");
  if (/\}\s*:\s*Request\b/.test(code)) problems.push("destructures the request");
  const names = [...code.matchAll(/(\w+)\s*:\s*Request\b/g)].map((m) => m[1]);
  for (const name of new Set(names)) {
    for (const m of code.matchAll(new RegExp(`\\b${name}\\b(?=(.{0,40}))`, "g"))) {
      const after = m[1];
      if (/^\s*:\s*Request\b/.test(after)) continue; // the parameter itself
      if (/^\s*\)/.test(after)) continue; // passed on whole, e.g. authorized(req)
      if (/^\.headers\.get\("authorization"\)/.test(after)) continue;
      problems.push(`reads ${name}${after.slice(0, 20)}`);
    }
  }
  return problems;
}

describe("no-secret-fields", () => {
  it("the walker catches planted secret fields, however deeply nested", () => {
    const planted = z.object({
      amount: z.string(),
      nested: z
        .object({
          list: z.array(z.union([z.object({ ok: z.string() }), z.object({ secretKey: z.string() })])),
        })
        .optional(),
      wrapped: z.object({ PinCode: z.string().nullable() }).transform((x) => x),
      seedPhrase: z.string().default(""),
      intersected: z.intersection(z.object({ a: z.string() }), z.object({ priv_key: z.string() })),
      lazy: z.lazy(() => z.object({ walletPassword: z.string() })),
    });
    expect(findSecretFields(planted).sort()).toEqual(
      [
        "input.nested.list[]|1.secretKey: forbidden field name",
        "input.wrapped.PinCode: forbidden field name",
        "input.seedPhrase: forbidden field name",
        "input.intersected.priv_key: forbidden field name",
        "input.lazy.walletPassword: forbidden field name",
      ].sort(),
    );
  });

  it("the walker fails closed on schemas that accept arbitrary keys", () => {
    expect(findSecretFields(z.record(z.string()))).toHaveLength(1);
    expect(findSecretFields(z.object({ x: z.any() }))).toHaveLength(1);
    expect(findSecretFields(z.object({}).passthrough())).toHaveLength(1);
    expect(findSecretFields((v: unknown) => v)).toHaveLength(1);
    expect(findSecretFields(z.object({ publicKey: z.string(), nonce: z.string(), signature: z.string() }))).toEqual([]);
  });

  it("no tRPC procedure input accepts a secret key, seed or pincode", () => {
    expect(Object.keys(appRouter._def.lazy ?? {})).toEqual([]); // lazy routers would hide their inputs
    const procedures = procedureInputs(appRouter);
    expect(procedures.length).toBeGreaterThan(0);
    const problems = procedures.flatMap(({ path: p, inputs }) =>
      inputs.flatMap((schema) => findSecretFields(schema, p)),
    );
    expect(problems).toEqual([]);
  });

  it("the only API routes under app/ are tRPC and the input-less cleanup job", () => {
    const routes = filesUnder(path.join(root, "app"))
      .filter((f) => /(^|\/)route\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f))
      .map(rel)
      .sort();
    expect(routes).toEqual(["app/api/cron/expire-trades/route.ts", "app/api/trpc/[trpc]/route.ts"]);
    // The cleanup job reads nothing from the request but its Authorization header.
    const cron = readFileSync(path.join(root, "app/api/cron/expire-trades/route.ts"), "utf8");
    expect(routeInputProblems(cron)).toEqual([]);
    expect(filesUnder(path.join(root, "pages", "api")).map(rel)).toEqual([]);
    expect(filesUnder(path.join(root, "src")).map(rel)).toEqual([]);
  });

  it("the input check on the cleanup job catches every way a route could read input", () => {
    const ok = `function authorized(req: Request) { return req.headers.get("authorization") === "x"; }
export async function GET(req: Request) { if (!authorized(req)) return new Response(""); return Response.json({}); }`;
    expect(routeInputProblems(ok)).toEqual([]);
    for (const bad of [
      `export async function POST(request: Request) { await request.json(); }`,
      `export async function GET(request: Request) { await request.json(); }`,
      `export async function GET({ headers, json }: Request) { await json(); }`,
      `export async function GET(req: Request) { const pin = req.headers.get("x-pincode"); }`,
      `export async function GET(req: Request) { await req["json"](); }`,
      `export async function GET(req: Request) { return new URL(req.url).searchParams; }`,
      `export const GET = async (req: Request) => req.text();`,
      `export { handler as GET };`,
    ]) {
      expect(routeInputProblems(bad), bad).not.toEqual([]);
    }
  });

  it("no server actions exist (they would be a second, unchecked input surface)", () => {
    const withAction = ["app", "components", "lib", "server"]
      .flatMap((d) => filesUnder(path.join(root, d)))
      .filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f))
      .filter((f) => /^\s*["']use server["']/m.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(withAction).toEqual([]);
  });
});
