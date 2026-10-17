import { defineConfig, devices } from "@playwright/test";
import { E2E_DATABASE_URL, E2E_WS_PROXY } from "./tests/e2e/env";

const PORT = 3100;
// Set E2E_BASE_URL to test an already-running app (local workerd preview or a deployment).
const externalBaseUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
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
        },
      },
});
