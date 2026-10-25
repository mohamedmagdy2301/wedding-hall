import { defineConfig, devices } from "@playwright/test";
import { LOCAL_FILE_STORE } from "./src/lib/r2";
import { E2E_DATABASE_URL, E2E_WS_PROXY } from "./tests/e2e/env";

const PORT = 3100;
// Set E2E_BASE_URL to test an already-running app (local workerd preview or a deployment).
const externalBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  // One venue per database: files run one after another, so a phase's journey never sees
  // another phase's data appear halfway (phase 2 asserts the initial "missing" steps).
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: externalBaseUrl ?? `http://localhost:${PORT}`,
    locale: "ar-EG",
    timezoneId: "Africa/Cairo",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `tsx tests/e2e/prepare-db.ts && npm run build && npm run start -- -p ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        env: {
          DATABASE_URL: E2E_DATABASE_URL,
          NEON_LOCAL_WSPROXY: E2E_WS_PROXY,
          // Documents and the logo in the local R2 stand-in (phase 9); local-only keys.
          ...LOCAL_FILE_STORE,
        },
      },
});
