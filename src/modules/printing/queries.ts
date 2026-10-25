import { and, eq } from "drizzle-orm";
import { bookings, venues } from "@/db/schema";
import { sortTiers } from "@/domain/cancellation-tiers";
import type { SessionUser } from "@/modules/auth/sessions";
import { snapshotTiers } from "@/modules/bookings/cancel";
import { getBooking } from "@/modules/bookings/queries";
import type { DbOrTx } from "@/modules/shared/db";
import { notFound } from "@/modules/shared/errors";

/**
 * P-01 and P-02 (`bookings.view`): the booking page's data, the venue's details and the
 * cancellation policy fixed with the booking at confirmation (D-68) — never the venue's
 * current one. Printed by the browser (CLAUDE.md rule 10).
 */
export async function getBookingPrint(db: DbOrTx, actor: SessionUser, bookingId: string, now: Date) {
  const data = await getBooking(db, actor, bookingId, now);
  const [extra] = await db
    .select({
      venueName: venues.name,
      venuePhone: venues.phone,
      venueAddress: venues.address,
      cancellationBasis: bookings.cancellationBasis,
      cancellationTiers: bookings.cancellationTiers,
    })
    .from(bookings)
    .innerJoin(venues, eq(venues.id, bookings.venueId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, actor.venueId)));
  if (!extra) throw notFound("bookingNotFound");
  return {
    ...data,
    venue: { name: extra.venueName, phone: extra.venuePhone, address: extra.venueAddress },
    // Longest notice first, as the contract reads them.
    policy:
      extra.cancellationBasis === null
        ? null
        : { basis: extra.cancellationBasis, tiers: sortTiers(snapshotTiers(extra.cancellationTiers)).reverse() },
  };
}
