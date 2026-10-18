import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { bookings, customers } from "@/db/schema";
import { displayStatus } from "@/domain/booking-status";
import { intrudesOtherSlot } from "@/domain/booking-time";
import { addDays, cairoDate } from "@/lib/time";
import type { SessionUser } from "@/modules/auth/sessions";
import { getTiming } from "@/modules/settings/venue";
import type { DbOrTx } from "@/modules/shared/db";
import { notFound } from "@/modules/shared/errors";
import { readSpaces } from "@/modules/spaces/service";
import { assertAllowed } from "@/modules/users-rbac/authorize";
import { findOverlapping, overlapsConfirmedSql } from "./repository";
import type { AvailabilityInput, CalendarInput } from "./schemas";
import { resolveTimes } from "./service";

/** API.md "Availability" (`bookings.view`, D-99). */

/**
 * `availability.check`: the times the booking would get — Cairo wall clock, summer time,
 * the current buffer (D-100, D-110) — and what overlaps them: confirmed bookings clash
 * (BR-12 warning), live tentative ones are information (D-08).
 */
export async function checkAvailability(db: DbOrTx, actor: SessionUser, input: AvailabilityInput, now: Date) {
  assertAllowed(actor, "bookings.view");
  const [space] = await readSpaces(db, actor.venueId, [input.spaceId]);
  if (!space) throw notFound("spaceNotFound");
  const { bufferMinutes } = await getTiming(db, actor.venueId);
  const times = resolveTimes(space, input, bufferMinutes);
  const found = await findOverlapping(
    db,
    { venueId: actor.venueId, spaceId: space.id, ...times, excludeBookingId: input.excludeBookingId },
    now,
  );
  const pick = ({ id, bookingNo, startsAt, endsAt }: (typeof found.confirmed)[number]) => ({
    id,
    bookingNo,
    startsAt,
    endsAt,
  });
  return {
    startsAt: times.startsAt,
    endsAt: times.endsAt,
    blockedUntil: times.blockedUntil,
    minutes: times.minutes,
    intrudesOtherSlot: intrudesOtherSlot(times, input.slotKind, space, input.eventDate),
    confirmedConflicts: found.confirmed.map(pick),
    tentativeOverlaps: found.tentative.map(pick),
  };
}

/**
 * `availability.calendar` (S-04): the spaces with their slots and the bookings whose party
 * starts in the Cairo date range, with the status shown now. The screen hides expired and
 * cancelled ones unless asked (D-104).
 */
export async function calendar(db: DbOrTx, actor: SessionUser, input: CalendarInput, now: Date) {
  assertAllowed(actor, "bookings.view");
  const allSpaces = await readSpaces(db, actor.venueId);
  const chosen = input.spaceIds.length > 0 ? allSpaces.filter((s) => input.spaceIds.includes(s.id)) : allSpaces;
  if (chosen.length === 0) return { spaces: allSpaces, bookings: [] };
  const rows = await db
    .select({
      id: bookings.id,
      bookingNo: bookings.bookingNo,
      spaceId: bookings.spaceId,
      slotKind: bookings.slotKind,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      status: bookings.status,
      tentativeExpiresAt: bookings.tentativeExpiresAt,
      guests: bookings.guests,
      total: bookings.total,
      customerName: customers.name,
      overlapsConfirmed: overlapsConfirmedSql,
    })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(
      and(
        eq(bookings.venueId, actor.venueId),
        inArray(
          bookings.spaceId,
          chosen.map((s) => s.id),
        ),
        sql`${bookings.startsAt} >= (${input.from}::date)::timestamp AT TIME ZONE 'Africa/Cairo'`,
        sql`${bookings.startsAt} < (${addDays(input.to, 1)}::date)::timestamp AT TIME ZONE 'Africa/Cairo'`,
      ),
    )
    .orderBy(asc(bookings.startsAt), asc(bookings.bookingNo));
  return {
    spaces: allSpaces,
    bookings: rows.map(({ overlapsConfirmed, ...b }) => ({
      ...b,
      eventDate: cairoDate(b.startsAt),
      displayStatus: displayStatus(b, now, overlapsConfirmed),
    })),
  };
}
