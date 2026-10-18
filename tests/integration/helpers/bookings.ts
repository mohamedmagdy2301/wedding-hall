import { eq } from "drizzle-orm";
import type { DbHandle } from "@/db/client";
import { bookings, customers, eventTypes, packages, spaceSlots, spaces, venues } from "@/db/schema";
import { cairoInstant, MINUTE_MS } from "@/lib/time";
import { markConfirmed } from "@/modules/bookings/confirm-transition";
import { setUpVenueWithOwner } from "./fixtures";

/**
 * PHASE5_PLAN §9.1: a venue with a 60-minute buffer, space A (day 13:00–18:00, evening
 * 20:00–01:00 past midnight, capacity 300) and space B (same slots, no capacity). Rows are
 * written directly so the constraint tests exercise the database alone.
 */

export const SLOTS = { day: { start: "13:00", end: "18:00" }, evening: { start: "20:00", end: "01:00" } };
export const TIERS = [{ minDaysBefore: 0, refundBps: 0 }];

export async function bookingWorld(handle: DbHandle) {
  const base = await setUpVenueWithOwner(handle);
  const db = handle.db;
  const venueId = base.venueId;
  await db.update(venues).set({ bufferMinutes: 60, tentativeHoldHours: 48 }).where(eq(venues.id, venueId));

  const space = async (name: string, capacityMax: number | null) => {
    const [row] = await db.insert(spaces).values({ venueId, name, capacityMax }).returning({ id: spaces.id });
    await db.insert(spaceSlots).values([
      { venueId, spaceId: row.id, kind: "day", startTime: SLOTS.day.start, endTime: SLOTS.day.end },
      { venueId, spaceId: row.id, kind: "evening", startTime: SLOTS.evening.start, endTime: SLOTS.evening.end },
    ]);
    return row.id;
  };
  const spaceA = await space("القاعة الكبرى", 300);
  const spaceB = await space("الروف", null);
  const [eventType] = await db
    .insert(eventTypes)
    .values({ venueId, name: "فرح", isWedding: true })
    .returning({ id: eventTypes.id });
  const pkg = async (spaceId: string, name: string) => {
    const [row] = await db
      .insert(packages)
      .values({ venueId, spaceId, name, baseGuests: 200, extraGuestPrice: 15_000 })
      .returning({ id: packages.id });
    return row.id;
  };
  const [customer] = await db
    .insert(customers)
    .values({ venueId, name: "عميل الاختبار", phone: "01001234567" })
    .returning({ id: customers.id });

  return {
    ...base,
    spaceA,
    spaceB,
    packageA: await pkg(spaceA, "الذهبي"),
    packageB: await pkg(spaceB, "الروف"),
    eventTypeId: eventType.id,
    customerId: customer.id,
  };
}

export type World = Awaited<ReturnType<typeof bookingWorld>>;

let sequence = 0;

export type RawBooking = {
  space?: "A" | "B";
  status: "tentative" | "confirmed" | "cancelled";
  /** Cairo date and time. */
  start: [string, string];
  end: [string, string];
  bufferMinutes?: number;
  tentativeExpiresAt?: Date;
};

/** The instants of a raw booking: Cairo wall times, blocked_until = end + buffer (BR-10). */
export function rawTimes(b: Pick<RawBooking, "start" | "end" | "bufferMinutes">) {
  const startsAt = cairoInstant(...b.start);
  const endsAt = cairoInstant(...b.end);
  return { startsAt, endsAt, blockedUntil: new Date(endsAt.getTime() + (b.bufferMinutes ?? 60) * MINUTE_MS) };
}

/** Inserts a complete booking row of the given status, bypassing every service check. */
export async function insertRawBooking(handle: DbHandle, w: World, b: RawBooking): Promise<string> {
  sequence += 1;
  const spaceId = b.space === "B" ? w.spaceB : w.spaceA;
  const actor = w.ownerId;
  const priced = {
    eventTypeId: w.eventTypeId,
    packageId: b.space === "B" ? w.packageB : w.packageA,
    guests: 200,
    basePrice: 6_000_000,
    extraGuestsAmount: 0,
    itemsTotal: 0,
    removalCreditsTotal: 0,
    discountAmount: 0,
    total: 6_000_000,
    baseGuests: 200,
    extraGuestPrice: 15_000,
  };
  const [row] = await handle.db
    .insert(bookings)
    .values({
      venueId: w.venueId,
      bookingNo: `9999-${String(sequence).padStart(4, "0")}`,
      spaceId,
      customerId: w.customerId,
      slotKind: "evening",
      ...rawTimes(b),
      status: b.status,
      tentativeExpiresAt: b.status === "confirmed" ? null : (b.tentativeExpiresAt ?? new Date("2099-01-01T00:00:00Z")),
      createdBy: actor,
      ...priced,
      ...(b.status === "confirmed"
        ? {
            confirmedAt: new Date(),
            confirmedBy: actor,
            cancellationBasis: "deposit" as const,
            cancellationTiers: [{ min_days_before: 0, refund_bps: 0 }],
          }
        : {}),
      ...(b.status === "cancelled" ? { cancelledAt: new Date(), cancelledBy: actor, cancelReason: "اختبار" } : {}),
    })
    .returning({ id: bookings.id });
  return row.id;
}

/** Confirms through the one transition of the code base (D-97), in its own transaction. */
export function confirmBooking(handle: DbHandle, w: World, bookingId: string, bufferMinutes = 60) {
  return handle.db.transaction((tx) =>
    markConfirmed(tx, {
      venueId: w.venueId,
      bookingId,
      confirmedBy: w.ownerId,
      now: new Date(),
      bufferMinutes,
      cancellationBasis: "deposit",
      cancellationTiers: TIERS,
    }),
  );
}
