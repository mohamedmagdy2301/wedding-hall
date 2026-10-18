import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { createDb, type DbHandle } from "@/db/client";

/** This worker's database: its own copy of the migrated template locally, the template on Neon. */
export function testDatabaseUrl(): string {
  const url = new URL(inject("testDatabaseUrl"));
  if (inject("testDatabasePerWorker")) {
    url.pathname = `${url.pathname}_w${process.env.VITEST_POOL_ID ?? "1"}`;
  }
  return url.toString();
}

/** Connects through the production driver (Neon serverless over WebSocket). */
export function connectTestDb(): DbHandle {
  return createDb(testDatabaseUrl(), { localWsProxy: inject("testWsProxy") });
}

export async function truncateAll(handle: DbHandle): Promise<void> {
  await handle.db.execute(sql`TRUNCATE TABLE venues RESTART IDENTITY CASCADE`);
}
