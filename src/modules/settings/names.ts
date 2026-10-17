import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import type { DbOrTx } from "@/modules/shared/db";
import { isUniqueViolation, validationError } from "@/modules/shared/errors";

/** A settings table with a unique `(venue_id, lower(name))` index (D-72). */
export type NamedTable = PgTable & { venueId: AnyPgColumn; name: AnyPgColumn; isActive: AnyPgColumn };

/**
 * Turns a violation of the name index into a field error; when the existing row is
 * inactive the message suggests reactivating it. Called after the failed transaction
 * rolled back, so the lookup runs on a fresh statement.
 */
export async function mapNameConflict(
  error: unknown,
  db: DbOrTx,
  table: NamedTable,
  constraint: string,
  venueId: string,
  name: string,
): Promise<never> {
  if (!isUniqueViolation(error, constraint)) throw error;
  const [existing] = await db
    .select({ isActive: table.isActive })
    .from(table)
    .where(and(eq(table.venueId, venueId), sql`lower(${table.name}) = lower(${name})`));
  throw validationError({ name: existing && existing.isActive === false ? "nameTakenInactive" : "nameTaken" });
}

/** Moves one item a step up or down a sorted list and returns the ids in their new order. */
export function moved<T extends { id: string }>(items: readonly T[], id: string, direction: "up" | "down"): T[] | null {
  const index = items.findIndex((i) => i.id === id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0) return null;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
