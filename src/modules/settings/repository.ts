import { asc, sql } from "drizzle-orm";
import type { DbOrTx } from "@/modules/shared/db";
import { venues } from "@/db/schema";

export type VenueSummary = { id: string; name: string };

/** Each deployment serves exactly one venue (D-01). */
export async function getVenueSummary(db: DbOrTx): Promise<VenueSummary | null> {
  const rows = await db
    .select({ id: venues.id, name: venues.name })
    .from(venues)
    .orderBy(asc(venues.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getDatabaseTime(db: DbOrTx): Promise<Date> {
  const result = await db.execute<{ now: string }>(sql`select now()::text as now`);
  return new Date(result.rows[0].now);
}
