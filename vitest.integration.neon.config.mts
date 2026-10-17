import { mergeConfig } from "vitest/config";
import integrationConfig from "./vitest.integration.config.mjs";

// Same integration suite against the real Neon project (throwaway database, dropped after the run).
process.env.TEST_TARGET = "neon";

export default mergeConfig(integrationConfig, {
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
