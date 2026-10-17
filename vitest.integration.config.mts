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
    // One shared database: run files sequentially to keep tests isolated.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
