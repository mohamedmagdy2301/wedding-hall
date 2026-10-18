import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests run against a real PostgreSQL 18 (docker compose), never mocks.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/integration/global-setup.ts"],
    // Files run in parallel locally, each worker on its own copy of the test database
    // (global-setup). The Neon config runs them in sequence on one database.
    maxWorkers: 8,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
