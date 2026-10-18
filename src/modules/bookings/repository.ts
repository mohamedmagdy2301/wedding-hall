import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { bookingCounters, bookings } from "@/db/schema";
import { bookingNumber } from "@/domain/booking-overlap";
import type { DbOrTx, Tx } from "@/modules/shared/db";

/**
 * Booking queries shared by the services. The status change to `confirmed` lives apart, in
 * its own file that nothing in src/ may import during phase 5 (D-97).
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
