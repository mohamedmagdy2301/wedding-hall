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

/** Recreates an empty test database and applies all migrations once per run. */
export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL || DEFAULT_ADMIN_URL;
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the test PostgreSQL at ${new URL(adminUrl).host}. Start it with: docker compose up -d`,
      { cause: error },
    );
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);
  } finally {
    await admin.end();
  }

  const testUrl = new URL(adminUrl);
  testUrl.pathname = `/${TEST_DB_NAME}`;
  await runMigrations(testUrl.toString());

  project.provide("testDatabaseUrl", testUrl.toString());
  // Set TEST_WS_PROXY="" to connect without the local proxy (e.g. a real Neon branch).
  project.provide("testWsProxy", (process.env.TEST_WS_PROXY ?? DEFAULT_WS_PROXY) || undefined);
}
