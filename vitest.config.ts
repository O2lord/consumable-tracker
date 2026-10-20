import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import path from "node:path";

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // `server-only` throws outside Next's server build; tests run in plain Node.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    // Integration tests make many round trips to the hosted dev database.
    // Each query costs a few hundred milliseconds, so a test that scans several bottles can pass 60s.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    // Load .env.local / .env so integration tests can reach the dev database.
    env: loadEnv(mode, process.cwd(), ""),
  },
}));
