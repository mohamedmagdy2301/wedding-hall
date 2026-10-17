import { sql } from "drizzle-orm";
import { inject } from "vitest";
import { createDb, type DbHandle } from "@/db/client";

/** Connects through the production driver (Neon serverless over WebSocket). */
export function connectTestDb(): DbHandle {
  return createDb(inject("testDatabaseUrl"), { localWsProxy: inject("testWsProxy") });
}

export async function truncateAll(handle: DbHandle): Promise<void> {
  await handle.db.execute(sql`TRUNCATE TABLE venues RESTART IDENTITY CASCADE`);
}
