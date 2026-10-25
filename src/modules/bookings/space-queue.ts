import { sql } from "drizzle-orm";
import type { Tx } from "@/modules/shared/db";

/**
 * Queues the transaction behind any other one changing confirmed bookings of the same space
 * (D-115): a transaction-scoped advisory lock keyed by the space, released at commit or
 * rollback. Confirmations of one space then wait their turn — the second sees the first
 * committed and the constraint refuses it at once — instead of each waiting for the other
 * inside the constraint check (a deadlock). Take it first in the transaction; taking it
 * again is harmless. Two spaces sharing a hash only share the queue.
 */
export async function queueOnSpace(tx: Tx, spaceId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bookings_no_overlap:${spaceId}`}, 0))`);
}
