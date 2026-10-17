import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../../scripts/migrate";

const DEFAULT_ADMIN_URL = "postgres://postgres:postgres@localhost:54329/postgres";
const DEFAULT_WS_PROXY = "localhost:54330";
const TEST_DB_NAME = "wedding_hall_test";

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrl: string;
    testWsProxy: string | undefined;
  }
}

type Target = { adminUrl: string; wsProxy: string | undefined; dropAfterRun: boolean };

/**
 * Local docker by default. TEST_TARGET=neon runs the same suite in a throwaway
 * database inside the Neon project (direct URL from .env.local, real WebSockets).
 */
async function resolveTarget(): Promise<Target> {
  if (process.env.TEST_TARGET === "neon") {
    const { requireEnv } = await import("../../scripts/lib/load-env");
    return { adminUrl: requireEnv("DATABASE_URL_UNPOOLED"), wsProxy: undefined, dropAfterRun: true };
  }
  return {
    adminUrl: process.env.TEST_DATABASE_ADMIN_URL || DEFAULT_ADMIN_URL,
    wsProxy: (process.env.TEST_WS_PROXY ?? DEFAULT_WS_PROXY) || undefined,
    dropAfterRun: false,
  };
}

async function withAdmin(adminUrl: string, run: (admin: Client) => Promise<void>) {
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch {
    // Host only: the URL itself carries credentials (SEC-32).
    throw new Error(`Cannot reach the test PostgreSQL at ${new URL(adminUrl).host}. Locally: docker compose up -d`);
  }
  try {
    await run(admin);
  } finally {
    await admin.end();
  }
}

/** Recreates an empty test database and applies all migrations once per run. */
export default async function setup(project: TestProject) {
  const target = await resolveTarget();
  await withAdmin(target.adminUrl, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  });

  const testUrl = new URL(target.adminUrl);
  testUrl.pathname = `/${TEST_DB_NAME}`;
  await runMigrations(testUrl.toString());

  project.provide("testDatabaseUrl", testUrl.toString());
  project.provide("testWsProxy", target.wsProxy);

  return async () => {
    if (!target.dropAfterRun) return;
    await withAdmin(target.adminUrl, async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    });
  };
}
