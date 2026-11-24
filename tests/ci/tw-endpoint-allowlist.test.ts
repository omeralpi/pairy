// SOW D2 and DECISIONS 13: Pairy can ask Trustless Work only for the calls a
// protected trade needs (create, fund, approve-and-release, dispute, resolve,
// submit and one read), only through server/tw/client.ts, and never builds a
// contract call of its own (PLAN I3, I6, I8, I14).
//
// Fails closed: every scan below is a plain function, and each one is run on
// planted violations first, so a scan that stopped finding anything fails here
// instead of passing quietly.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { AnyRouter } from "@trpc/server";
import { z, type ZodTypeAny } from "zod";
import { describe, expect, it } from "vitest";

import { TW_API_BASE } from "@/lib/escrow/config";
import { appRouter } from "@/server/api/root";
import { TW_ENDPOINTS } from "@/server/tw/client";

type Source = { file: string; text: string };

const CLIENT = "server/tw/client.ts";
const CONFIG = "lib/escrow/config.ts";
const READ = "lib/escrow/read.ts";

/** The frozen allowlist (FIXES X-01, F-20). */
const EXPECTED_ENDPOINTS = {
  deploy: { method: "POST", path: "/escrow/single-release/v2/deploy" },
  fund: { method: "POST", path: "/escrow/single-release/v2/fund" },
  approveAndRelease: { method: "POST", path: "/escrow/single-release/v2/approve-and-release-milestones" },
  dispute: { method: "POST", path: "/escrow/single-release/v2/dispute" },
  resolve: { method: "POST", path: "/escrow/single-release/v2/resolve-dispute" },
  submit: { method: "POST", path: "/stellar/send-transaction" },
  read: { method: "GET", path: "/escrows/{contractId}" },
};

/** Calls Pairy never makes (FIXES F-20, X-01): role or milestone changes, the resolver's sweep, other escrow types. */
const FORBIDDEN_CALLS = [
  "update-escrow",
  "updateEscrow",
  "withdraw-remaining",
  "withdrawRemainingFunds",
  "multi-release",
  "single-release/v2/update",
  "manage-milestones",
  "release-funds",
  "approve-milestones",
  "change-milestone-status",
  "changeMilestoneStatus",
  "extend-ttl",
];

const root = process.cwd();

/** FIXES F-14: *.ts and *.tsx under these directories, tests excluded. */
function sources(): Source[] {
  return ["app", "components", "lib", "server", "scripts"].flatMap((dir) => {
    if (!existsSync(path.join(root, dir))) return [];
    return (readdirSync(path.join(root, dir), { recursive: true }) as string[])
      .map((f) => path.join(dir, f).split(path.sep).join("/"))
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("/node_modules/"))
      .map((file) => ({ file, text: readFileSync(path.join(root, file), "utf8") }));
  });
}

const rootFile = (file: string): Source[] =>
  existsSync(path.join(root, file)) ? [{ file, text: readFileSync(path.join(root, file), "utf8") }] : [];

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
/** An import, dynamic import or require of a module path matching `target`. */
const imports = (text: string, target: string) =>
  new RegExp(`(?:\\bfrom|\\bimport|\\brequire)\\s*\\(?\\s*["'][^"'\\n]*\\b${target}\\b`).test(text);
const flag = (files: Source[], test: (s: Source) => boolean, why: string) =>
  files.filter(test).map((s) => `${s.file}: ${why}`);

/** #2: the API host is written only in the client and the escrow config. viewer.trustlesswork.com is fine anywhere. */
function hostProblems(files: Source[]): string[] {
  return flag(
    files,
    (s) => s.file !== CLIENT && s.file !== CONFIG && /api\.trustlesswork\.com/.test(s.text),
    "names a Trustless Work API host",
  );
}

/**
 * The whole first argument of the client's fetch: the allowlisted path, with
 * only the read's contract address filled in, and nothing after it (WP-08
 * judge N1: a "/../x" suffix would reach another path).
 */
const FETCH_URL =
  /\bfetch\(\s*TW_API_BASE \+ TW_ENDPOINTS\[ep\]\.path(?:\.replace\("\{contractId\}", \(\) => \(body as TwInput\["read"\]\)\.contractId\))?\s*[,)]/;

/** #3: one fetch, to TW_API_BASE + an allowlisted path, and the key read nowhere else. */
function clientProblems(files: Source[]): string[] {
  const client = files.find((s) => s.file === CLIENT);
  if (!client) return [`${CLIENT}: missing`];
  const code = withoutComments(client.text);
  const fetches = code.match(/\bfetch\s*\(/g)?.length ?? 0;
  return [
    ...(fetches === 1 ? [] : [`${CLIENT}: calls fetch ${fetches} times, not once`]),
    ...(FETCH_URL.test(code) ? [] : [`${CLIENT}: the fetch URL is not TW_API_BASE + TW_ENDPOINTS[ep].path`]),
    ...(/process\.env\.TRUSTLESS_WORK_API_KEY\b/.test(code) ? [] : [`${CLIENT}: does not read TRUSTLESS_WORK_API_KEY`]),
    ...flag([client], (s) => imports(s.text, "lib/db"), "imports from lib/db"),
    ...flag(
      files,
      (s) => s.file !== CLIENT && /TRUSTLESS_WORK_API_KEY/.test(s.text),
      "names TRUSTLESS_WORK_API_KEY (only the client reads it)",
    ),
    ...flag(files, (s) => /\bTW_API_KEY\b/.test(s.text), "names TW_API_KEY (the key is TRUSTLESS_WORK_API_KEY)"),
    ...flag(files, (s) => /NEXT_PUBLIC_(TW|TRUSTLESS)/.test(s.text), "puts a Trustless Work setting in the browser bundle"),
    ...flag(
      files,
      (s) => s.file !== CLIENT && s.file !== CONFIG && /\bTW_API_BASE\b/.test(s.text),
      "uses TW_API_BASE (only the client calls Trustless Work)",
    ),
  ];
}

/** #4: browser and shared code never reach the client (PLAN I14 covers lib/escrow/read.ts). */
function importProblems(files: Source[]): string[] {
  return flag(
    files,
    (s) => /^(app|components|lib)\//.test(s.file) && imports(s.text, "server/tw"),
    "imports server/tw",
  );
}

/** #5 */
function forbiddenCallProblems(files: Source[]): string[] {
  return files.flatMap((s) => FORBIDDEN_CALLS.filter((w) => s.text.includes(w)).map((w) => `${s.file}: mentions ${w}`));
}

/** Every object key anywhere in a zod schema. */
function inputKeys(schema: unknown, seen = new Set<unknown>()): string[] {
  const def = (schema as ZodTypeAny | undefined)?._def as Record<string, any> | undefined;
  if (!def || seen.has(schema)) return [];
  seen.add(schema);
  const own =
    def.typeName === "ZodObject"
      ? Object.entries(def.shape() as Record<string, unknown>).flatMap(([k, v]) => [k, ...inputKeys(v, seen)])
      : [];
  const inner = [
    def.innerType,
    def.schema,
    def.type,
    def.in,
    def.out,
    def.left,
    def.right,
    ...(def.options ?? []),
    ...(def.items ?? []),
    // z.record, z.map, z.set and z.lazy (WP-08 judge N2).
    def.keyType,
    def.valueType,
    typeof def.getter === "function" ? def.getter() : undefined,
  ];
  return [...own, ...inner.flatMap((s) => inputKeys(s, seen))];
}

function procedureInputs(router: AnyRouter): { path: string; inputs: unknown[] }[] {
  return Object.entries(router._def.procedures as Record<string, { _def: { inputs: unknown[] } }>).map(
    ([p, proc]) => ({ path: p, inputs: proc._def.inputs }),
  );
}

/** #6: the server picks addresses, amounts and outcomes; the browser only names the trade (PLAN I8). */
function routerInputProblems(procedures: { path: string; inputs: unknown[] }[]): string[] {
  const rules: [RegExp, RegExp][] = [
    [/^arbiter\./, /address|amount|recipient|destination|distribution|outcome|winner/i],
    [/^escrow\.prepare/, /roles|path|endpoint|url|body/i],
  ];
  return procedures.flatMap(({ path: p, inputs }) =>
    rules
      .filter(([proc]) => proc.test(p))
      .flatMap(([, key]) => inputs.flatMap((s) => inputKeys(s)).filter((k) => key.test(k)))
      .map((k) => `${p}: input key ${k}`),
  );
}

/** #7: contract calls are built only for simulation, in lib/escrow/read.ts, which never signs or submits. */
function contractCallProblems(files: Source[]): string[] {
  return [
    ...flag(
      files,
      (s) =>
        s.file !== READ &&
        /Operation\.invokeHostFunction\(|Operation\.invokeContractFunction\(|\bcontract\.Client\b|new Contract\(/.test(s.text),
      "builds a contract call",
    ),
    ...flag(
      files,
      (s) => s.file === READ && /\.sign\(|signTransaction|submitTransaction|sendTransaction/.test(s.text),
      "signs or submits",
    ),
  ];
}

/** #8: the browser submits every signed transaction; the server only verifies by hash (PLAN I3). */
function submitProblems(files: Source[]): string[] {
  return [
    ...flag(
      files,
      (s) => /^(server|app\/api)\//.test(s.file) && /\b(submitTransaction|sendTransaction|submit)\(/.test(s.text),
      "submits a transaction",
    ),
    ...flag(files, (s) => /twCall\(\s*["']submit["']/.test(s.text), "asks Trustless Work to submit (allowlisted, unused)"),
  ];
}

const SOURCES = sources();

describe("tw-endpoint-allowlist", () => {
  it("1: the endpoint list is exactly the frozen set, on the beta API host", () => {
    expect(TW_ENDPOINTS).toStrictEqual(EXPECTED_ENDPOINTS);
    expect(TW_API_BASE).toBe("https://beta.api.trustlesswork.com");
  });

  it("2: the Trustless Work API host appears only in the client and the escrow config", () => {
    expect(hostProblems(SOURCES)).toEqual([]);
  });

  it("3: the client fetches once, from the allowlist, and is the only reader of the key", () => {
    expect(clientProblems([...SOURCES, ...rootFile("next.config.mjs")])).toEqual([]);
    expect(readFileSync(path.join(root, ".env.example"), "utf8")).not.toMatch(/NEXT_PUBLIC_(TW|TRUSTLESS)|\bTW_API_KEY\b/);
  });

  it("4: nothing under app/, components/ or lib/ imports server/tw", () => {
    expect(importProblems(SOURCES)).toEqual([]);
  });

  it("5: no source names a call Pairy never makes", () => {
    expect(forbiddenCallProblems(SOURCES)).toEqual([]);
  });

  it("6: arbiter and escrow-prepare inputs carry no address, amount, outcome or request shape", () => {
    expect(Object.keys(appRouter._def.lazy ?? {})).toEqual([]); // lazy routers would hide their inputs
    const procedures = procedureInputs(appRouter);
    // The check must see the real procedures: a rename would otherwise make it pass on nothing (WP-08 judge N3).
    const arbiterWithInput = ["arbiter.byId", "arbiter.prepareResolution", "arbiter.addSignature", "arbiter.recordResolution"];
    expect(procedures.map((p) => p.path)).toEqual(
      expect.arrayContaining(["escrow.prepareCreate", "escrow.prepareFund", "escrow.prepareRelease", ...arbiterWithInput]),
    );
    expect(procedures.filter((p) => p.path.startsWith("escrow.prepare")).every((p) => p.inputs.length > 0)).toBe(true);
    // The arbiter procedures that take input are exactly these (me and list take none): a new or renamed one is named here first.
    expect(procedures.filter((p) => p.path.startsWith("arbiter.") && p.inputs.length > 0).map((p) => p.path).sort()).toEqual([...arbiterWithInput].sort());
    expect(routerInputProblems(procedures)).toEqual([]);
  });

  it("7: no source builds a contract call outside lib/escrow/read.ts", () => {
    expect(contractCallProblems(SOURCES)).toEqual([]);
  });

  it("8: no server code submits a transaction", () => {
    expect(submitProblems(SOURCES)).toEqual([]);
  });

  describe("9: each scan finds planted violations", () => {
    const planted: Source[] = [
      {
        file: CLIENT,
        text: [
          "const key = process.env.TRUSTLESS_WORK_API_KEY;",
          'export const TW_ENDPOINTS = { updateEscrow: { method: "PUT", path: "/escrow/single-release/v2/update" } };',
          "await fetch(TW_API_BASE + TW_ENDPOINTS[ep].path);",
          'await fetch("https://dev.api.trustlesswork.com/escrow/multi-release/deploy");',
          'import { db } from "@/lib/db";',
        ].join("\n"),
      },
      { file: CONFIG, text: 'export const TW_API_BASE = "https://beta.api.trustlesswork.com";' },
      { file: "lib/escrow/sweep.ts", text: 'const p = "/escrow/single-release/v2/withdraw-remaining-funds";' },
      {
        file: "components/escrow/create-panel.tsx",
        text: 'import { twCall } from "@/server/tw/client";\nconst op = Operation.invokeHostFunction({ func });',
      },
      {
        file: "server/api/routers/escrow.ts",
        text: 'await horizon.submitTransaction(tx);\nawait twCall("submit", { signedXdr }, {});\nfetch(TW_API_BASE + "/x");',
      },
      { file: "app/(app)/page.tsx", text: 'const k = process.env.NEXT_PUBLIC_TW_KEY ?? process.env.TW_API_KEY;' },
      { file: READ, text: "const op = Operation.invokeHostFunction({ func });\nawait wallet.signTransaction(xdr);" },
      { file: "lib/escrow/fine.ts", text: '"https://viewer.trustlesswork.com/testnet/v2/" + id; "/approve-and-release-milestones";' },
    ];

    it("an extra endpoint, or a PUT to /update", () => {
      expect({ ...TW_ENDPOINTS, updateEscrow: { method: "PUT", path: "/escrow/single-release/v2/update" } }).not.toStrictEqual(
        EXPECTED_ENDPOINTS,
      );
      expect({ ...TW_ENDPOINTS, fund: { method: "POST", path: "/escrow/single-release/v2/fund-escrow" } }).not.toStrictEqual(
        EXPECTED_ENDPOINTS,
      );
    });

    it("an API host outside the client and the config", () => {
      expect(hostProblems(planted)).toEqual([]); // CLIENT and CONFIG may name it; the viewer is fine
      expect(hostProblems([...planted, { file: "lib/x.ts", text: "https://api.trustlesswork.com" }])).toEqual([
        "lib/x.ts: names a Trustless Work API host",
      ]);
    });

    it("a second fetch, a db import and the key or base read elsewhere", () => {
      expect(clientProblems(planted).sort()).toEqual(
        [
          `${CLIENT}: calls fetch 2 times, not once`,
          `${CLIENT}: imports from lib/db`,
          "app/(app)/page.tsx: names TW_API_KEY (the key is TRUSTLESS_WORK_API_KEY)",
          "app/(app)/page.tsx: puts a Trustless Work setting in the browser bundle",
          "server/api/routers/escrow.ts: uses TW_API_BASE (only the client calls Trustless Work)",
        ].sort(),
      );
      expect(clientProblems([{ file: CLIENT, text: "await fetch(`${base}${p}`);" }]).sort()).toEqual(
        [`${CLIENT}: the fetch URL is not TW_API_BASE + TW_ENDPOINTS[ep].path`, `${CLIENT}: does not read TRUSTLESS_WORK_API_KEY`].sort(),
      );
      expect(clientProblems([])).toEqual([`${CLIENT}: missing`]);
      // Anything after the allowlisted path is refused, with or without the read's placeholder filled in.
      const key = "process.env.TRUSTLESS_WORK_API_KEY;\n";
      for (const call of [
        'await fetch(TW_API_BASE + TW_ENDPOINTS[ep].path + "/../x", {',
        'await fetch(TW_API_BASE + TW_ENDPOINTS[ep].path.replace("{contractId}", () => (body as TwInput["read"]).contractId) + "/../x", {',
        'await fetch(TW_API_BASE + TW_ENDPOINTS[ep].path.replace("{contractId}", () => "../x"), {',
        "await fetch(TW_API_BASE + TW_ENDPOINTS[ep].pathname, {",
      ]) {
        expect(clientProblems([{ file: CLIENT, text: key + call }]), call).toEqual([
          `${CLIENT}: the fetch URL is not TW_API_BASE + TW_ENDPOINTS[ep].path`,
        ]);
      }
      for (const call of [
        'await fetch(TW_API_BASE + TW_ENDPOINTS[ep].path.replace("{contractId}", () => (body as TwInput["read"]).contractId), {',
        "await fetch(TW_API_BASE + TW_ENDPOINTS[ep].path, {",
      ]) {
        expect(clientProblems([{ file: CLIENT, text: key + call }]), call).toEqual([]);
      }
      expect(clientProblems([...planted, { file: "next.config.mjs", text: "env: { TRUSTLESS_WORK_API_KEY: x }" }])).toContain(
        "next.config.mjs: names TRUSTLESS_WORK_API_KEY (only the client reads it)",
      );
    });

    it("an import of server/tw from browser code", () => {
      expect(importProblems(planted)).toEqual(["components/escrow/create-panel.tsx: imports server/tw"]);
      for (const text of [
        'import { twCall } from "../../server/tw/client";',
        'const { twCall } = await import("@/server/tw/client");',
        'const c = require("@/server/tw/client");',
        'import "@/server/tw/client";',
      ]) {
        expect(importProblems([{ file: READ, text }]), text).toHaveLength(1);
      }
      // A mention in prose is not an import.
      expect(importProblems([{ file: CONFIG, text: "/** Trustless Work's API. Only server/tw/client.ts calls it. */" }])).toEqual([]);
    });

    it("a forbidden call, including withdraw-remaining-funds and the PUT /update path", () => {
      expect(forbiddenCallProblems(planted).sort()).toEqual(
        [
          `${CLIENT}: mentions updateEscrow`,
          `${CLIENT}: mentions single-release/v2/update`,
          `${CLIENT}: mentions multi-release`,
          "lib/escrow/sweep.ts: mentions withdraw-remaining",
        ].sort(),
      );
    });

    it("an arbiter input that picks the payee, or a prepare input that shapes the request", () => {
      const procs = [
        { path: "arbiter.prepareResolution", inputs: [z.object({ tradeId: z.string(), payout: z.object({ recipient: z.string() }) })] },
        { path: "arbiter.addSignature", inputs: [z.object({ resolutionId: z.string(), signedXdr: z.string() })] },
        { path: "escrow.prepareCreate", inputs: [z.object({ tradeId: z.string(), admin: z.string(), roles: z.array(z.string()) })] },
        { path: "escrow.prepareFund", inputs: [z.object({ tradeId: z.string() }).transform((x) => x)] },
        { path: "trade.open", inputs: [z.object({ amount: z.string() })] },
      ];
      expect(routerInputProblems(procs)).toEqual([
        "arbiter.prepareResolution: input key recipient",
        "escrow.prepareCreate: input key roles",
      ]);
      // Keys inside a record, a map, a set or a lazy schema are seen too.
      const nested = [
        { path: "escrow.prepareCreate", inputs: [z.object({ tradeId: z.string(), meta: z.record(z.object({ body: z.string() })) })] },
        { path: "escrow.prepareFund", inputs: [z.object({ tradeId: z.string(), m: z.map(z.string(), z.object({ url: z.string() })) })] },
        { path: "escrow.prepareRelease", inputs: [z.object({ tradeId: z.string(), s: z.set(z.object({ path: z.string() })) })] },
        { path: "arbiter.addSignature", inputs: [z.object({ resolutionId: z.string(), l: z.lazy(() => z.object({ amount: z.string() })) })] },
      ];
      expect(routerInputProblems(nested)).toEqual([
        "escrow.prepareCreate: input key body",
        "escrow.prepareFund: input key url",
        "escrow.prepareRelease: input key path",
        "arbiter.addSignature: input key amount",
      ]);
    });

    it("a contract call built in a UI file, and signing in read.ts", () => {
      expect(contractCallProblems(planted)).toEqual([
        "components/escrow/create-panel.tsx: builds a contract call",
        `${READ}: signs or submits`,
      ]);
    });

    it("a submit in a router", () => {
      expect(submitProblems(planted)).toEqual([
        "server/api/routers/escrow.ts: submits a transaction",
        "server/api/routers/escrow.ts: asks Trustless Work to submit (allowlisted, unused)",
      ]);
    });
  });
});
