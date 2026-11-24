import path from "node:path";
import { defineConfig } from "vitest/config";

// Real Postgres (PG_TEST_URL): concurrent transactions, which pglite cannot
// run, so these tests prove the listing row lock and not only the check.
// Outside the default include on purpose; the unit step never needs Postgres.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/pg/**/*.pg.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["./vitest.setup.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
