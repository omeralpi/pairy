import path from "node:path";
import { defineConfig } from "vitest/config";

// Real testnet: Friendbot, Horizon round-trips and a 60-second claim window
// waited out inside the run, so timeouts are minutes, not seconds.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.testnet.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
