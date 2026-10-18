import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { bookingCounters, bookings } from "@/db/schema";
import { bookingNumber } from "@/domain/booking-overlap";
import type { DisplayStatus } from "@/domain/booking-status";
import type { DbOrTx, Tx } from "@/modules/shared/db";

/**
 * Booking queries shared by the services. The status change to `confirmed` lives apart, in
 * its own file that only the confirmation service imports (D-97, D-127).
 */

export type OverlapCandidate = {
  venueId: string;
  spaceId: string;
  startsAt: Date;
  blockedUntil: Date;
  excludeBookingId?: string | null;
};

export type OverlapRow = {
  id: string;
  bookingNo: string;
  status: "tentative" | "confirmed" | "cancelled";
  tentativeExpiresAt: Date | null;
  startsAt: Date;
  endsAt: Date;
};

/**
 * Bookings of the space whose `[starts_at, blocked_until)` overlaps the candidate's — the
 * exact test of `bookings_no_overlap` (BR-11), for warnings only (BR-12, D-08): confirmed
 * ones clash; tentative ones that have not expired are reported as information.
 */
export async function findOverlapping(
  db: DbOrTx,
  candidate: OverlapCandidate,
  now: Date,
): Promise<{ confirmed: OverlapRow[]; tentative: OverlapRow[] }> {
  const rows = await db
    .select({
      id: bookings.id,
      bookingNo: bookings.bookingNo,
      status: bookings.status,
      tentativeExpiresAt: bookings.tentativeExpiresAt,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.venueId, candidate.venueId),
        eq(bookings.spaceId, candidate.spaceId),
        inArray(bookings.status, ["tentative", "confirmed"]),
        sql`tstzrange(${bookings.startsAt}, ${bookings.blockedUntil}, '[)') && tstzrange(${candidate.startsAt.toISOString()}::timestamptz, ${candidate.blockedUntil.toISOString()}::timestamptz, '[)')`,
        candidate.excludeBookingId ? ne(bookings.id, candidate.excludeBookingId) : undefined,
      ),
    )
    .orderBy(bookings.startsAt, bookings.bookingNo);
  return {
    confirmed: rows.filter((r) => r.status === "confirmed"),
    tentative: rows.filter((r) => r.status === "tentative" && r.tentativeExpiresAt && r.tentativeExpiresAt > now),
  };
}

/**
 * True when another confirmed booking of the same space overlaps this row's
 * `[starts_at, blocked_until)` — the "conflicting" display status of a tentative booking
 * (BR-13). For queries selecting from `bookings` without an alias.
 */
// Qualified by hand: drizzle renders a column of a single-table select without its table,
// which inside this subquery would mean `c`.
export const overlapsConfirmedSql = sql<boolean>`EXISTS (SELECT 1 FROM bookings c WHERE c.space_id = "bookings"."space_id"
  AND c.status = 'confirmed' AND c.id <> "bookings"."id"
  AND tstzrange(c.starts_at, c.blocked_until, '[)') && tstzrange("bookings"."starts_at", "bookings"."blocked_until", '[)'))`;

/** The SQL condition of a display status at `now` (ADR-007), mirroring `displayStatus`. */
export function displayStatusCondition(status: DisplayStatus, now: Date): SQL {
  const at = sql`${now.toISOString()}::timestamptz`;
  switch (status) {
    case "cancelled":
      return sql`${bookings.status} = 'cancelled'`;
    case "confirmed":
      return sql`${bookings.status} = 'confirmed' AND ${bookings.endsAt} > ${at}`;
    case "completed":
      return sql`${bookings.status} = 'confirmed' AND ${bookings.endsAt} <= ${at}`;
    case "expired":
      return sql`${bookings.status} = 'tentative' AND ${bookings.tentativeExpiresAt} <= ${at}`;
    case "conflicting":
      return sql`${bookings.status} = 'tentative' AND ${bookings.tentativeExpiresAt} > ${at} AND ${overlapsConfirmedSql}`;
    case "tentative":
      return sql`${bookings.status} = 'tentative' AND ${bookings.tentativeExpiresAt} > ${at} AND NOT ${overlapsConfirmedSql}`;
  }
}

/**
 * Upcoming bookings of a space for the deactivation warning (D-75, D-112): confirmed and
 * live tentative bookings whose party has not ended.
 */
export async function countUpcomingBookings(db: DbOrTx, venueId: string, spaceId: string, now: Date) {
  const at = sql`${now.toISOString()}::timestamptz`;
  const [row] = await db
    .select({
      confirmed: sql<number>`count(*) FILTER (WHERE ${bookings.status} = 'confirmed')::int`,
      tentative: sql<number>`count(*) FILTER (WHERE ${bookings.status} = 'tentative' AND ${bookings.tentativeExpiresAt} > ${at})::int`,
    })
    .from(bookings)
    .where(and(eq(bookings.venueId, venueId), eq(bookings.spaceId, spaceId), sql`${bookings.endsAt} > ${at}`));
  return { confirmed: row.confirmed, tentative: row.tentative };
}

/**
 * The next booking number of the venue for a Cairo year (BR-26, D-105). The upsert locks the
 * counter row until the transaction ends: no duplicates under concurrency, and a failed
 * booking gives its number back.
 */
export async function nextBookingNumber(tx: Tx, venueId: string, year: number): Promise<string> {
  const [row] = await tx
    .insert(bookingCounters)
    .values({ venueId, year, lastNo: 1 })
    .onConflictDoUpdate({
      target: [bookingCounters.venueId, bookingCounters.year],
      set: { lastNo: sql`${bookingCounters.lastNo} + 1`, updatedAt: sql`now()` },
    })
    .returning({ lastNo: bookingCounters.lastNo });
  return bookingNumber(year, row.lastNo);
}
