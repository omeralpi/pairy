// SOW D1 and DECISIONS 0.3, 4, O-5, O-6: Privy is a login and a wallet the
// user signs with, nothing more. Pairy runs no Privy server SDK, holds no
// Privy secret, calls no Privy API itself, and never gives Privy a signer, a
// delegated action, a key quorum or a custom JWT login. This test is that
// boundary (D1 §8): an allowlist of what the one Privy file may import, plus a
// denylist as a second guard. It is green before the first Privy import lands
// (WP-18) and stays the gate once it does (WP-19).
//
// Fails closed: every scan below is a plain function, and each one is run on
// planted violations first, so a scan that stopped finding anything fails here
// instead of passing quietly.

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AnyRouter } from "@trpc/server";
import { z, type ZodTypeAny } from "zod";
import { describe, expect, it } from "vitest";

import { appRouter } from "@/server/api/root";

type Source = { file: string; text: string };
type Dependencies = Record<string, string> | undefined;
type PackageJson = Record<string, Dependencies>;

/** The only file that may import Privy (D1 §1.2). */
const PRIVY_FILE = "components/providers/privy-layer.tsx";
/** The only Privy package, pinned exactly (D1 §8 #1). */
const PRIVY_PACKAGE = "@privy-io/react-auth";
const PRIVY_VERSION = "3.51.1";
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
/** Privy's server SDKs and the REST types they are built on, matched as a name prefix (fail-closed: a new @privy-io/node-* is caught too). */
const SERVER_PACKAGES = ["@privy-io/server-auth", "@privy-io/node", "@privy-io/public-api"];

/** Frozen by S-01 (WP-06) against the installed 3.51.1 .d.ts: module → the named imports Pairy uses. */
const ALLOWED_IMPORTS: Record<string, string[]> = {
  "@privy-io/react-auth": ["PrivyProvider", "usePrivy", "useLogin", "useLogout"],
  "@privy-io/react-auth/extended-chains": ["useCreateWallet", "useSignRawHash", "useExportWallet"],
};

/** Custom-JWT login, signers, delegated actions, key import or export, server clients (D1 §8 #4 plus the S-01 scan). */
const DENIED = [
  "customAuth",
  "getCustomAccessToken",
  "loginWithCustomAccessToken",
  "useSubscribeToJwtAuthWithFlag",
  "SessionSigner",
  "useSessionSigners",
  "addSessionSigners",
  "removeSessionSigners",
  "useSigners",
  "useDelegatedActions",
  "delegateWallet",
  "useAuthorizationSignature",
  "authorizationKey",
  "authorizationPrivateKey",
  "keyQuorum",
  "KeyQuorum",
  "PrivyClient",
  "walletApi",
  "delegated",
  "useHeadlessDelegatedActions",
  "useGetWalletPrivateKey",
  "useCustomAuth",
  "useLinkJwtAccount",
  "useSyncJwtBasedAuthState",
  "usePrivyClient_experimental",
  "useImportWallet",
  "useImportSeedPhrase",
  "useGuestAccounts",
  // Takes precedence over loginMethods and admits SMS, external wallets and cross-app logins.
  "loginMethodsAndOrder",
];

/** DECISIONS 0.3: email and Google, no passkey. */
const LOGIN_METHODS = ["email", "google"];
/** PRIVY_APP_SECRET, NEXT_PUBLIC_PRIVY_APP_SECRET, privy-app-secret, privyAppSecret, ... */
const APP_SECRET = /privy[-_]?app[-_]?secret/i;
/** A tRPC input the server must never receive: Privy identity (D1 §8 #7). */
const IDENTITY_KEY = /email|privy|^did$|accesstoken|idtoken/i;
/** Privy's REST and auth hosts, its request headers and its cookies: code that names one calls or trusts Privy itself (D1 §0, PLAN I4). */
const PRIVY_API: [RegExp, string][] = [
  [/\b(api|auth)\.privy\.io\b/i, "names a Privy API host"],
  [/\bprivy-app-id\b/i, "sends the privy-app-id header"],
  [/\bprivy-authorization-signature\b/i, "sends the privy-authorization-signature header"],
  [/\bprivy-(id-)?token\b/i, "reads a Privy cookie"],
];

const root = process.cwd();
/** Never source: dependencies and build output. Dot-directories other than .github are skipped too (.git, .next, .vercel, the evidence .state). */
const SKIPPED_DIRS = new Set(["node_modules", "coverage", "out"]);

/** Every file under `base`, as a path relative to it. */
function walk(base: string, dir = ""): string[] {
  return readdirSync(path.join(base, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const skipped = SKIPPED_DIRS.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".github");
      return skipped ? [] : walk(base, rel);
    }
    return entry.isFile() ? [rel] : [];
  });
}

const read = (base: string, files: string[]): Source[] =>
  files.map((file) => ({ file, text: readFileSync(path.join(base, file), "utf8") }));

const isSource = (f: string) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f) && !/\.test\.[jt]sx?$/.test(f) && !f.startsWith("tests/");
/** FIXES F-14: every source file in the repository, tests excluded. A new top-level directory (hooks/, public/, ...) is in by default. */
const sourceFiles = (base: string) => walk(base).filter(isSource);
const sources = (): Source[] => read(root, sourceFiles(root));

/** Everything a secret could be written into: the sources plus every JSON, YAML, Markdown and .env.example file. */
function textFiles(): Source[] {
  const isText = (f: string) => (/\.(json|ya?ml|md)$/.test(f) && !f.startsWith("tests/")) || path.basename(f) === ".env.example";
  return read(root, walk(root).filter((f) => isSource(f) || isText(f)));
}

/** Block comments and `//` comments (URLs keep their `//`). */
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const flag = (files: Source[], test: (s: Source) => boolean, why: string) =>
  files.filter(test).map((s) => `${s.file}: ${why}`);

/** #1: the only Privy package is the browser SDK, pinned exactly; no server package, no range, no npm alias of one. */
function packageProblems(pkg: PackageJson): string[] {
  return DEPENDENCY_SECTIONS.flatMap((section) =>
    Object.entries(pkg[section] ?? {})
      .filter(([name, version]) => name.startsWith("@privy-io/") || version.includes("@privy-io/"))
      .flatMap(([name, version]) => {
        if (name !== PRIVY_PACKAGE) return [`package.json ${section}: ${name} ("${version}") is not ${PRIVY_PACKAGE}`];
        if (version !== PRIVY_VERSION) return [`package.json ${section}: ${name} is "${version}", not pinned "${PRIVY_VERSION}"`];
        return [];
      }),
  );
}

/**
 * #1, lockfile: pnpm-lock.yaml lists every installed package, so a Privy server SDK shows up there however it came
 * in: as a dependency, under an npm alias, or through another package that wraps it (WP-18 judge, note 1).
 */
function lockfileProblems(lock: string): string[] {
  // A deprecation notice is prose ("use @privy-io/node instead"), not a package.
  const entries = lock.split("\n").filter((line) => !/^\s*deprecated:/.test(line)).join("\n");
  return SERVER_PACKAGES.filter((p) => entries.includes(p)).map((p) => `pnpm-lock.yaml: has ${p}`);
}

/** #2: one integration point. Any `@privy-io/` in code outside it (import, require, a string) is a second one. */
function integrationPointProblems(files: Source[]): string[] {
  return flag(
    files,
    (s) => s.file !== PRIVY_FILE && withoutComments(s.text).includes("@privy-io/"),
    "names @privy-io/ (only privy-layer.tsx may)",
  );
}

/** #3: in the Privy file, only static named imports from the two allowed modules, and only the frozen names. */
function importProblems(files: Source[]): string[] {
  const layer = files.find((s) => s.file === PRIVY_FILE);
  if (!layer) return [];
  const code = withoutComments(layer.text);
  const problems: string[] = [];
  let statics = 0;
  for (const [, clause, from] of code.matchAll(/\bimport\s+(?:type\s+)?([^;]*?)\s+from\s*["']([^"'\n]+)["']/g)) {
    if (!from.startsWith("@privy-io/")) continue;
    statics++;
    const allowed = ALLOWED_IMPORTS[from];
    if (!allowed) {
      problems.push(`${PRIVY_FILE}: imports ${from}, not an allowed module`);
      continue;
    }
    const named = clause.trim().match(/^\{([^}]*)\}$/);
    if (!named) {
      problems.push(`${PRIVY_FILE}: "${clause.trim()}" from ${from} is not a named import`);
      continue;
    }
    for (const spec of named[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const name = spec.replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (!allowed.includes(name)) problems.push(`${PRIVY_FILE}: imports ${name} from ${from}, not in the allowlist`);
    }
  }
  const mentions = code.match(/@privy-io\//g)?.length ?? 0;
  if (mentions !== statics) problems.push(`${PRIVY_FILE}: names @privy-io/ ${mentions} times but imports it statically ${statics} times`);
  if (/\bimport\s*\(/.test(code)) problems.push(`${PRIVY_FILE}: uses a dynamic import`);
  if (/\brequire\s*\(/.test(code)) problems.push(`${PRIVY_FILE}: uses require`);
  if (/\bexport\s+(\*|\{[^}]*\})\s+from\b/.test(code)) problems.push(`${PRIVY_FILE}: re-exports a module`);
  return problems;
}

/** #4: none of the denied identifiers in code (comments are prose and are skipped). */
function deniedProblems(files: Source[]): string[] {
  return files.flatMap((s) => {
    const code = withoutComments(s.text);
    return DENIED.filter((w) => new RegExp(`\\b${w}\\b`).test(code)).map((w) => `${s.file}: uses ${w}`);
  });
}

/**
 * #5: the PrivyProvider config: email and Google only, no auto-created wallet, no custom auth. Checked in every
 * file, since a config can be spread in from anywhere; and the Privy file must set the login list itself.
 */
function providerConfigProblems(files: Source[]): string[] {
  const problems: string[] = [];
  const layer = files.find((s) => s.file === PRIVY_FILE);
  if (layer && !/\bloginMethods\s*:\s*\[/.test(withoutComments(layer.text))) {
    problems.push(`${PRIVY_FILE}: loginMethods is not a literal list in the PrivyProvider config`);
  }
  for (const s of files) {
    const code = withoutComments(s.text);
    if (/\bloginMethods\s*:(?!\s*\[)/.test(code)) problems.push(`${s.file}: loginMethods is not a literal list`);
    for (const [, list] of code.matchAll(/\bloginMethods\s*:\s*\[([^\]]*)\]/g)) {
      const entries = list.split(",").map((e) => e.trim()).filter(Boolean);
      const literals = entries.flatMap((e) => e.match(/^["']([^"']*)["']$/)?.[1] ?? []);
      if (literals.length !== entries.length) problems.push(`${s.file}: loginMethods has an entry that is not a string literal`);
      for (const m of literals) if (!LOGIN_METHODS.includes(m)) problems.push(`${s.file}: loginMethods allows "${m}"`);
      if (!literals.includes("email")) problems.push(`${s.file}: loginMethods lacks "email"`);
    }
    for (const [, value] of code.matchAll(/\bcreateOnLogin\s*:\s*([^,}\n]+)/g)) {
      if (!/^["']off["']$/.test(value.trim())) problems.push(`${s.file}: createOnLogin is ${value.trim()}, not "off"`);
    }
    if (/\bcustomAuth\s*:/.test(code)) problems.push(`${s.file}: the PrivyProvider config has a customAuth key`);
  }
  return problems;
}

/** #6: no app secret anywhere. Privy's App ID is public; there is no secret for Pairy to hold. */
function appSecretProblems(files: Source[]): string[] {
  return flag(files, (s) => APP_SECRET.test(s.text), "names a Privy app secret");
}

/** Every object key anywhere in a zod schema, through wrappers, unions, records and lazies. */
function inputKeys(schema: unknown, seen = new Set<unknown>()): string[] {
  const def = (schema as ZodTypeAny | undefined)?._def as Record<string, any> | undefined;
  if (!def || typeof def.typeName !== "string" || seen.has(schema)) return [];
  seen.add(schema);
  const own = def.typeName === "ZodObject" ? Object.entries(def.shape() as Record<string, unknown>) : [];
  const inner = def.typeName === "ZodLazy" ? [def.getter()] : Object.values(def);
  return [
    ...own.flatMap(([k, v]) => [k, ...inputKeys(v, seen)]),
    ...inner.flat().flatMap((s) => inputKeys(s, seen)),
  ];
}

function procedureInputs(router: AnyRouter): { path: string; inputs: unknown[] }[] {
  return Object.entries(router._def.procedures as Record<string, { _def: { inputs: unknown[] } }>).map(
    ([p, proc]) => ({ path: p, inputs: proc._def.inputs }),
  );
}

/** #7: the server never receives Privy identity; it knows a user by the Stellar address that signed the challenge. */
function identityInputProblems(procedures: { path: string; inputs: unknown[] }[]): string[] {
  return procedures.flatMap(({ path: p, inputs }) =>
    inputs.flatMap((s) => inputKeys(s)).filter((k) => IDENTITY_KEY.test(k)).map((k) => `${p}: input key ${k}`),
  );
}

/** #8: no code calls or trusts Privy directly: not its REST or auth hosts, not its headers, not its cookies. The SDK knows its own hosts. */
function privyApiProblems(files: Source[]): string[] {
  return files.flatMap((s) => {
    const code = withoutComments(s.text);
    return PRIVY_API.filter(([re]) => re.test(code)).map(([, why]) => `${s.file}: ${why}`);
  });
}

const SOURCES = sources();
const PACKAGE_JSON = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
const LOCKFILE = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");

describe("no-privy-signers", () => {
  it("the scan sees the source tree", () => {
    const files = SOURCES.map((s) => s.file);
    expect(files).toContain("components/providers/wallet-provider.tsx");
    expect(files).toContain("server/api/root.ts");
    expect(files).toContain("next.config.mjs");
    expect(files.filter((f) => f.includes(".test.") || f.startsWith("tests/") || f.includes("node_modules"))).toEqual([]);
  });

  it("1: the only Privy package is @privy-io/react-auth, pinned exactly", () => {
    expect(packageProblems(PACKAGE_JSON)).toEqual([]);
  });

  it("1: pnpm-lock.yaml holds no Privy server package, direct, aliased or brought in by another package", () => {
    expect(LOCKFILE).toContain(`'${PRIVY_PACKAGE}@${PRIVY_VERSION}'`);
    expect(lockfileProblems(LOCKFILE)).toEqual([]);
  });

  it("2: only components/providers/privy-layer.tsx mentions @privy-io/", () => {
    expect(integrationPointProblems(SOURCES)).toEqual([]);
  });

  it("3: the Privy file imports only the frozen names from the two allowed modules", () => {
    expect(importProblems(SOURCES)).toEqual([]);
  });

  it("4: no source uses a signer, delegation, key-export, custom-auth or server-client identifier", () => {
    expect(deniedProblems(SOURCES)).toEqual([]);
  });

  it("5: the PrivyProvider config allows email and Google only, creates no wallet on login and has no custom auth", () => {
    expect(providerConfigProblems(SOURCES)).toEqual([]);
  });

  it("6: no file names a Privy app secret", () => {
    const files = textFiles();
    expect(files.map((s) => s.file)).toEqual(expect.arrayContaining([".env.example", ".github/workflows/ci.yml", "package.json"]));
    expect(appSecretProblems(files)).toEqual([]);
  });

  it("7: no tRPC input key carries Privy identity", () => {
    expect(Object.keys(appRouter._def.lazy ?? {})).toEqual([]); // lazy routers would hide their inputs
    const procedures = procedureInputs(appRouter);
    expect(procedures.length).toBeGreaterThan(0);
    expect(identityInputProblems(procedures)).toEqual([]);
  });

  it("8: no source names a Privy API host, header or cookie", () => {
    expect(privyApiProblems(SOURCES)).toEqual([]);
  });

  describe("9: each scan finds planted violations", () => {
    const layer = (imports: string, config = 'loginMethods: ["email", "google"], embeddedWallets: { ethereum: { createOnLogin: "off" }, solana: { createOnLogin: "off" } }') => ({
      file: PRIVY_FILE,
      text: `'use client';\n${imports}\nexport function PrivyLayer({ children }) {\n  return <PrivyProvider appId={appId} config={{ ${config} }}>{children}</PrivyProvider>;\n}\n`,
    });
    const spikeLayer = layer(
      'import { PrivyProvider } from "@privy-io/react-auth";\nimport { useCreateWallet, useSignRawHash, useExportWallet } from "@privy-io/react-auth/extended-chains";\nimport { usePrivy, useLogin, useLogout } from "@privy-io/react-auth";',
    );

    it("a source in a new top-level directory or in public/, but not a test, a dependency or build output", () => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "no-privy-signers-"));
      try {
        for (const f of [
          "hooks/use-server-signer.ts",
          "public/privy.js",
          "types/x.d.ts",
          "middleware.ts",
          "lib/ok.ts",
          "lib/ok.test.ts",
          "components/ok.test.tsx",
          "tests/ci/x.test.ts",
          "tests/helper.ts",
          "node_modules/@privy-io/server-auth/index.js",
          ".next/server/app.js",
          "scripts/evidence/.state/key.json",
          ".env.example",
          "docs/a.md",
        ]) {
          mkdirSync(path.join(tmp, path.dirname(f)), { recursive: true });
          writeFileSync(path.join(tmp, f), "");
        }
        expect(sourceFiles(tmp).sort()).toEqual(["hooks/use-server-signer.ts", "lib/ok.ts", "middleware.ts", "public/privy.js", "types/x.d.ts"]);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("a server package, a second package, a range, a different version or an npm alias", () => {
      expect(packageProblems({ dependencies: { "@privy-io/react-auth": PRIVY_VERSION } })).toEqual([]);
      expect(packageProblems({ dependencies: { next: "14.2.35" } })).toEqual([]);
      expect(packageProblems({ dependencies: { "@privy-io/react-auth": PRIVY_VERSION, "@privy-io/server-auth": "1.28.0" } })).toEqual([
        'package.json dependencies: @privy-io/server-auth ("1.28.0") is not @privy-io/react-auth',
      ]);
      expect(packageProblems({ devDependencies: { "@privy-io/node": "0.4.0" } })).toHaveLength(1);
      expect(packageProblems({ optionalDependencies: { "@privy-io/wagmi": "1.0.0" } })).toHaveLength(1);
      expect(packageProblems({ peerDependencies: { "@privy-io/public-api": "1.0.0" } })).toHaveLength(1);
      expect(packageProblems({ dependencies: { "@privy-io/react-auth": "^3.51.1" } })).toEqual([
        'package.json dependencies: @privy-io/react-auth is "^3.51.1", not pinned "3.51.1"',
      ]);
      expect(packageProblems({ dependencies: { "@privy-io/react-auth": "3.52.0" } })).toHaveLength(1);
      // An npm alias hides the package behind another name (R2).
      expect(packageProblems({ dependencies: { "auth-kit": "npm:@privy-io/server-auth@1.28.0" } })).toEqual([
        'package.json dependencies: auth-kit ("npm:@privy-io/server-auth@1.28.0") is not @privy-io/react-auth',
      ]);
      expect(packageProblems({ devDependencies: { privy: "npm:@privy-io/react-auth@3.51.1" } })).toHaveLength(1);
    });

    it("a Privy server package in the lockfile: direct, under an npm alias or through a wrapper, but not the browser SDK's own packages", () => {
      const direct = [
        "importers:",
        "  .:",
        "    dependencies:",
        "      '@privy-io/server-auth':",
        "        specifier: 1.32.5",
        "        version: 1.32.5",
      ].join("\n");
      const alias = ["      auth-kit:", "        specifier: npm:@privy-io/server-auth@1.32.5", "        version: '@privy-io/server-auth@1.32.5'"].join("\n");
      // A wrapper such as AgentKit's PrivyWalletProvider: package.json names only the wrapper.
      const wrapper = ["snapshots:", "  '@coinbase/agentkit@0.10.4':", "    dependencies:", "      '@privy-io/server-auth': 1.32.5"].join("\n");
      for (const lock of [direct, alias, wrapper]) expect(lockfileProblems(lock), lock).toEqual(["pnpm-lock.yaml: has @privy-io/server-auth"]);
      for (const p of SERVER_PACKAGES) expect(lockfileProblems(`packages:\n  '${p}@0.4.0':\n`), p).toEqual([`pnpm-lock.yaml: has ${p}`]);
      expect(lockfileProblems("  '@privy-io/node-sdk@1.0.0':")).toEqual(["pnpm-lock.yaml: has @privy-io/node"]);
      // react-auth 3.51.1's own closure (WP-18 judge): none is a server package.
      const browser = ["react-auth@3.51.1", "js-sdk-core@0.79.2", "api-base@2.0.0", "api-types@0.24.0", "routes@0.5.0", "urls@0.0.5"];
      expect(lockfileProblems(browser.map((p) => `  '@privy-io/${p}': {}`).join("\n"))).toEqual([]);
      // A deprecation notice is prose, not a package (server-auth 1.32.5's own notice names @privy-io/node).
      const notice = "    deprecated: This package is deprecated. If you are looking for the latest features and support, use @privy-io/node instead.";
      expect(lockfileProblems(`  '@privy-io/react-auth@3.51.1':\n${notice}`)).toEqual([]);
      expect(lockfileProblems(`${direct}\n${notice}`)).toEqual(["pnpm-lock.yaml: has @privy-io/server-auth"]);
    });

    it("an allowlisted hook imported from a file other than privy-layer.tsx", () => {
      const planted: Source[] = [
        spikeLayer,
        { file: "lib/wallet/privy-sign.ts", text: 'import { useSignRawHash } from "@privy-io/react-auth/extended-chains";' },
        { file: "server/api/routers/auth.ts", text: 'const { PrivyClient } = require("@privy-io/server-auth");' },
        { file: "app/api/privy/route.ts", text: 'const m = await import("@privy-io/node");' },
        { file: "components/wallet/privy-mock.tsx", text: 'vi.mock("@privy-io/react-auth", () => ({}));' },
        { file: "hooks/use-server-signer.ts", text: 'import { useSessionSigners } from "@privy-io/react-auth";' },
        // Prose is not an integration point: the alias comment in next.config.mjs (S-01) and a doc comment.
        { file: "next.config.mjs", text: "// @privy-io/react-auth probes for a Farcaster mini-app host\n'@farcaster/mini-app-solana': false," },
        { file: "components/wallet/sign-confirm-dialog.tsx", text: "/* the shape @privy-io/react-auth returns */" },
        { file: "lib/wallet/use-wallet.ts", text: 'export type WalletKind = "device" | "freighter" | "privy";' },
      ];
      expect(integrationPointProblems(planted)).toEqual([
        "lib/wallet/privy-sign.ts: names @privy-io/ (only privy-layer.tsx may)",
        "server/api/routers/auth.ts: names @privy-io/ (only privy-layer.tsx may)",
        "app/api/privy/route.ts: names @privy-io/ (only privy-layer.tsx may)",
        "components/wallet/privy-mock.tsx: names @privy-io/ (only privy-layer.tsx may)",
        "hooks/use-server-signer.ts: names @privy-io/ (only privy-layer.tsx may)",
      ]);
    });

    it("a signer hook, a wrong module, a namespace, default, dynamic, side-effect or type import, a require, a re-export", () => {
      expect(importProblems([spikeLayer])).toEqual([]);
      expect(importProblems([])).toEqual([]);
      const cases: [string, string][] = [
        ['import { PrivyProvider, useSessionSigners } from "@privy-io/react-auth";', "imports useSessionSigners from @privy-io/react-auth, not in the allowlist"],
        ['import { useSigners as useLogin } from "@privy-io/react-auth";', "imports useSigners from @privy-io/react-auth, not in the allowlist"],
        ['import { useSignRawHash } from "@privy-io/react-auth";', "imports useSignRawHash from @privy-io/react-auth, not in the allowlist"],
        ['import type { User } from "@privy-io/react-auth";', "imports User from @privy-io/react-auth, not in the allowlist"],
        ['import { PrivyProvider, type User } from "@privy-io/react-auth";', "imports User from @privy-io/react-auth, not in the allowlist"],
        ['import { PrivyClient } from "@privy-io/server-auth";', "imports @privy-io/server-auth, not an allowed module"],
        ['import { useSolanaWallets } from "@privy-io/react-auth/solana";', "imports @privy-io/react-auth/solana, not an allowed module"],
        ['import * as Privy from "@privy-io/react-auth";', '"* as Privy" from @privy-io/react-auth is not a named import'],
        ['import Privy from "@privy-io/react-auth";', '"Privy" from @privy-io/react-auth is not a named import'],
        ['import PrivyProvider, { usePrivy } from "@privy-io/react-auth";', '"PrivyProvider, { usePrivy }" from @privy-io/react-auth is not a named import'],
        ['import "@privy-io/react-auth";', "names @privy-io/ 1 times but imports it statically 0 times"],
        ['const m = await import("@privy-io/react-auth/extended-chains");', "uses a dynamic import"],
        ['const { useSigners } = require("@privy-io/react-auth");', "uses require"],
        ['export { usePrivy } from "@privy-io/react-auth";', "re-exports a module"],
        ['export * from "@privy-io/react-auth";', "re-exports a module"],
        ['const mod = "@privy-io/react-auth";', "names @privy-io/ 1 times but imports it statically 0 times"],
      ];
      for (const [imports, problem] of cases) {
        expect(importProblems([layer(imports)]), imports).toContain(`${PRIVY_FILE}: ${problem}`);
      }
      // A multi-line named import, an alias of an allowed name and a URL in a comment are fine.
      expect(
        importProblems([
          layer('import {\n  PrivyProvider,\n  usePrivy as usePrivyAuth,\n} from "@privy-io/react-auth"; // https://docs.privy.io/'),
        ]),
      ).toEqual([]);
    });

    it("a denied identifier in code, under any module or alias, but not in a comment", () => {
      const planted: Source[] = [
        { file: "lib/wallet/privy-sign.ts", text: 'const { addSessionSigners } = useSessionSigners();\nawait addSessionSigners({ address });' },
        { file: "server/privy.ts", text: 'const privy = new PrivyClient(appId, process.env.X);\nconst { walletApi } = privy;' },
        { file: PRIVY_FILE, text: 'config={{ customAuth: { isLoading: false, getCustomAccessToken } }}' },
        { file: "lib/wallet/pick.ts", text: "const w = wallets.find((x) => x.delegated === false);" },
        { file: "components/wallet/x.tsx", text: 'const flag = "useDelegatedActions"; useHeadlessDelegatedActions();' },
        { file: "lib/wallet/ok.ts", text: "// Privy holds no delegated key and no useSessionSigners here.\n/* keyQuorum: none */\nexport const ok = 1;" },
      ];
      expect(deniedProblems(planted).sort()).toEqual(
        [
          "lib/wallet/privy-sign.ts: uses addSessionSigners",
          "lib/wallet/privy-sign.ts: uses useSessionSigners",
          "server/privy.ts: uses PrivyClient",
          "server/privy.ts: uses walletApi",
          `${PRIVY_FILE}: uses customAuth`,
          `${PRIVY_FILE}: uses getCustomAccessToken`,
          "lib/wallet/pick.ts: uses delegated",
          "components/wallet/x.tsx: uses useDelegatedActions",
          "components/wallet/x.tsx: uses useHeadlessDelegatedActions",
        ].sort(),
      );
      // Every name on the list is matched as a whole word, so each one is caught on its own.
      for (const w of DENIED) expect(deniedProblems([{ file: "x.ts", text: `${w}();` }]), w).toEqual([`x.ts: uses ${w}`]);
      expect(deniedProblems([{ file: "x.ts", text: "const delegatedTo = 1; const customAuthz = 2;" }])).toEqual([]);
      // Privy's precedence key would override loginMethods (R1).
      expect(deniedProblems([layer("", 'loginMethods: ["email", "google"], loginMethodsAndOrder: { primary: ["email", "google", "metamask", "wallet_connect"] }')])).toEqual([
        `${PRIVY_FILE}: uses loginMethodsAndOrder`,
      ]);
    });

    it("a passkey, a missing email, a non-literal login list, a wallet created on login, a custom auth key, in any file", () => {
      expect(providerConfigProblems([spikeLayer])).toEqual([]);
      expect(providerConfigProblems([])).toEqual([]);
      const cases: [string, string][] = [
        ['loginMethods: ["email", "google", "passkey"]', 'loginMethods allows "passkey"'],
        ["loginMethods: ['email', 'sms']", 'loginMethods allows "sms"'],
        ['loginMethods: ["google"]', 'loginMethods lacks "email"'],
        ["loginMethods: [...methods]", "loginMethods has an entry that is not a string literal"],
        ["loginMethods: methods", "loginMethods is not a literal list in the PrivyProvider config"],
        ["appearance: {}", "loginMethods is not a literal list in the PrivyProvider config"],
        ['loginMethods: ["email"], embeddedWallets: { ethereum: { createOnLogin: "all-users" } }', 'createOnLogin is "all-users", not "off"'],
        ["loginMethods: ['email'], embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' } }", "createOnLogin is 'users-without-wallets', not \"off\""],
        ['loginMethods: ["email"], embeddedWallets: { ethereum: { createOnLogin: mode } }', 'createOnLogin is mode, not "off"'],
        ['loginMethods: ["email"], customAuth: { isLoading, getCustomAccessToken }', "the PrivyProvider config has a customAuth key"],
      ];
      for (const [config, problem] of cases) {
        expect(providerConfigProblems([layer("", config)]), config).toContain(`${PRIVY_FILE}: ${problem}`);
      }
      // The config written as a variable in the same file is still read.
      expect(providerConfigProblems([{ file: PRIVY_FILE, text: 'const cfg = {\n  loginMethods: ["email", "google", "twitter"],\n};' }])).toEqual([
        `${PRIVY_FILE}: loginMethods allows "twitter"`,
      ]);
      // A config spread in from another file is read too (R1), and the Privy file must still set its own list.
      const extra: Source = {
        file: "lib/privy-config.ts",
        text: 'export const extra = {\n  loginMethods: ["email", "passkey", "wallet"],\n  embeddedWallets: { ethereum: { createOnLogin: "all-users" } },\n};',
      };
      expect(providerConfigProblems([spikeLayer, extra])).toEqual([
        'lib/privy-config.ts: loginMethods allows "passkey"',
        'lib/privy-config.ts: loginMethods allows "wallet"',
        'lib/privy-config.ts: createOnLogin is "all-users", not "off"',
      ]);
      expect(providerConfigProblems([{ file: "lib/x.ts", text: "const c = { loginMethods: methods };" }])).toEqual(["lib/x.ts: loginMethods is not a literal list"]);
      expect(providerConfigProblems([layer("", "...extra"), { file: "lib/x.ts", text: 'const extra = { loginMethods: ["email", "google"] };' }])).toEqual([
        `${PRIVY_FILE}: loginMethods is not a literal list in the PrivyProvider config`,
      ]);
    });

    it("an app secret in .env.example, a workflow or source, under any spelling", () => {
      const planted: Source[] = [
        { file: ".env.example", text: "NEXT_PUBLIC_PRIVY_APP_ID=\n# PRIVY_APP_SECRET=\n" },
        { file: ".github/workflows/ci.yml", text: "          NEXT_PUBLIC_PRIVY_APP_SECRET: ${{ secrets.X }}" },
        { file: "server/privy.ts", text: 'headers: { "privy-app-secret": secret }' },
        { file: "lib/x.ts", text: "const privyAppSecret = process.env.FOO;" },
        { file: "docs/ok.md", text: "NEXT_PUBLIC_PRIVY_APP_ID is public, not a secret; there is no app secret, ever." },
      ];
      expect(appSecretProblems(planted)).toEqual([
        ".env.example: names a Privy app secret",
        ".github/workflows/ci.yml: names a Privy app secret",
        "server/privy.ts: names a Privy app secret",
        "lib/x.ts: names a Privy app secret",
      ]);
    });

    it("a Privy identity key in a tRPC input, however nested", () => {
      const procs = [
        { path: "auth.verify", inputs: [z.object({ publicKey: z.string(), nonce: z.string(), signature: z.string(), email: z.string() })] },
        { path: "auth.link", inputs: [z.object({ user: z.object({ did: z.string() }).optional() }).transform((x) => x)] },
        { path: "auth.privy", inputs: [z.union([z.object({ accessToken: z.string() }), z.object({ idToken: z.string() })])] },
        { path: "auth.deep", inputs: [z.object({ meta: z.record(z.lazy(() => z.object({ privyUserId: z.string() }))) })] },
        { path: "auth.arrays", inputs: [z.array(z.object({ EmailAddress: z.string() })).nullable()] },
        { path: "trade.open", inputs: [z.object({ listingId: z.string(), amount: z.string(), didYouMean: z.string().optional() })] },
      ];
      expect(identityInputProblems(procs)).toEqual([
        "auth.verify: input key email",
        "auth.link: input key did",
        "auth.privy: input key accessToken",
        "auth.privy: input key idToken",
        "auth.deep: input key privyUserId",
        "auth.arrays: input key EmailAddress",
      ]);
    });

    it("a server call to Privy's REST or auth API, its headers or its cookies, but not a docs link", () => {
      const planted: Source[] = [
        {
          file: "server/privy/rest.ts",
          text: [
            'const BASE = "https://api.privy.io/v1";',
            "await fetch(`${BASE}/wallets/${walletId}/signers`, { method: \"POST\", headers: { \"privy-app-id\": appId, Authorization: basic } });",
            "await fetch(`${BASE}/key_quorums`, { method: \"POST\" });",
            'await fetch("https://api.privy.io/v1/policies", { method: "POST" });',
            'await fetch("https://api.privy.io/v1/wallets", { method: "POST" });',
          ].join("\n"),
        },
        { file: "server/privy/sig.ts", text: 'headers.set("Privy-Authorization-Signature", sig);' },
        {
          file: "app/api/me/route.ts",
          text: 'const token = cookies().get("privy-token")?.value ?? req.headers.get("privy-id-token");\nawait fetch("https://auth.privy.io/api/v1/apps/x/jwks.json");',
        },
        { file: "lib/ok.ts", text: "// See https://docs.privy.io/ and https://api.privy.io/v1 for the shapes.\nexport const ok = 1;" },
        { file: "components/ok.tsx", text: 'const href = "https://docs.privy.io/guide/react/wallets/export";' },
      ];
      expect(privyApiProblems(planted).sort()).toEqual(
        [
          "server/privy/rest.ts: names a Privy API host",
          "server/privy/rest.ts: sends the privy-app-id header",
          "server/privy/sig.ts: sends the privy-authorization-signature header",
          "app/api/me/route.ts: names a Privy API host",
          "app/api/me/route.ts: reads a Privy cookie",
        ].sort(),
      );
    });
  });
});
