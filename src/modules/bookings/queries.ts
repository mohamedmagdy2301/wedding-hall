import { and, asc, count, desc, eq, ilike, inArray, isNull, like, or, sql, type SQL } from "drizzle-orm";
import {
  auditLogs,
  bookingItems,
  bookings,
  customers,
  eventTypes,
  packageItems,
  packagePrices,
  packages,
  seasons,
  spaces,
  users,
} from "@/db/schema";
import { displayStatus } from "@/domain/booking-status";
import { bookableSlotKinds } from "@/domain/catalog";
import { toAsciiDigits } from "@/lib/digits";
import { cairoDate, cairoTimeOfDay } from "@/lib/time";
import { normalizeEgyptianMobile } from "@/modules/auth/login-id";
import type { SessionUser } from "@/modules/auth/sessions";
import { readServices } from "@/modules/catalog/services";
import { bookingPayments, netPaidSql } from "@/modules/payments/queries";
import { getTiming } from "@/modules/settings/venue";
import type { DbOrTx } from "@/modules/shared/db";
import { forbidden, notFound } from "@/modules/shared/errors";
import { readSpaces } from "@/modules/spaces/service";
import { assertAllowed, satisfies } from "@/modules/users-rbac/authorize";
import { displayStatusCondition, findOverlapping, overlapsConfirmedSql, requestedQuantity } from "./repository";
import type { BookingListFilters } from "./schemas";

/** Reads for the booking screens (S-05, S-06, S-07). Statuses are computed at read time (ADR-007). */

export const BOOKINGS_PAGE_SIZE = 50;

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** S-05 search: a booking number, a mobile (phone or second phone), part of a number, or part of a name. */
function searchCondition(search: string): SQL | undefined {
  const text = search.trim();
  if (!text) return undefined;
  const ascii = toAsciiDigits(text);
  if (/^\d{4}-\d+$/.test(ascii)) return eq(bookings.bookingNo, ascii);
  const phone = normalizeEgyptianMobile(text);
  if (phone) return or(eq(customers.phone, phone), eq(customers.altPhone, phone));
  const digits = ascii.replace(/[\s\-()+]/g, "");
  if (/^\d{3,}$/.test(digits)) {
    return or(
      like(bookings.bookingNo, `%${digits}%`),
      like(customers.phone, `%${digits}%`),
      like(customers.altPhone, `%${digits}%`),
    );
  }
  return ilike(customers.name, `%${likeEscape(text)}%`);
}

const cairoDayStart = (date: string) => sql`(${date}::date)::timestamp AT TIME ZONE 'Africa/Cairo'`;
const cairoDayEnd = (date: string) => sql`((${date}::date + 1))::timestamp AT TIME ZONE 'Africa/Cairo'`;

/** S-05 (`bookings.view`): search, filters on the status shown now, space, slot and Cairo dates. */
export async function listBookings(db: DbOrTx, actor: SessionUser, filters: BookingListFilters, now: Date) {
  assertAllowed(actor, "bookings.view");
  const where = and(
    eq(bookings.venueId, actor.venueId),
    searchCondition(filters.search),
    filters.status ? displayStatusCondition(filters.status, now) : undefined,
    filters.spaceId ? eq(bookings.spaceId, filters.spaceId) : undefined,
    filters.slotKind ? eq(bookings.slotKind, filters.slotKind) : undefined,
    filters.from ? sql`${bookings.startsAt} >= ${cairoDayStart(filters.from)}` : undefined,
    filters.to ? sql`${bookings.startsAt} < ${cairoDayEnd(filters.to)}` : undefined,
    // "عليه متبقي" (S-05): confirmed, completed included (BR-24), with money still due (BR-62).
    filters.balance === "due" ? sql`${bookings.status} = 'confirmed' AND ${bookings.total} > ${netPaidSql}` : undefined,
  );
  const page = Math.max(1, filters.page);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: bookings.id,
        bookingNo: bookings.bookingNo,
        startsAt: bookings.startsAt,
        endsAt: bookings.endsAt,
        slotKind: bookings.slotKind,
        spaceName: spaces.name,
        customerName: customers.name,
        customerPhone: customers.phone,
        total: bookings.total,
        status: bookings.status,
        tentativeExpiresAt: bookings.tentativeExpiresAt,
        overlapsConfirmed: overlapsConfirmedSql,
        paid: netPaidSql,
      })
      .from(bookings)
      .innerJoin(spaces, eq(spaces.id, bookings.spaceId))
      .innerJoin(customers, eq(customers.id, bookings.customerId))
      .where(where)
      .orderBy(desc(bookings.startsAt), desc(bookings.bookingNo))
      .limit(BOOKINGS_PAGE_SIZE)
      .offset((page - 1) * BOOKINGS_PAGE_SIZE),
    db
      .select({ total: count() })
      .from(bookings)
      .innerJoin(customers, eq(customers.id, bookings.customerId))
      .where(where),
  ]);
  return {
    rows: rows.map(({ overlapsConfirmed, paid, ...b }) => ({
      ...b,
      eventDate: cairoDate(b.startsAt),
      displayStatus: displayStatus(b, now, overlapsConfirmed),
      // Owed only on a confirmed booking: a cancelled one shows no debt (BR-76, D-53).
      remaining: b.status === "confirmed" && b.total !== null ? b.total - paid : null,
    })),
    total,
    page,
    pageSize: BOOKINGS_PAGE_SIZE,
  };
}

/** S-07 (`bookings.view`): the booking, its lines, the confirmed bookings it clashes with and its history (D-108). */
export async function getBooking(db: DbOrTx, actor: SessionUser, bookingId: string, now: Date) {
  assertAllowed(actor, "bookings.view");
  const [row] = await db
    .select({
      id: bookings.id,
      bookingNo: bookings.bookingNo,
      status: bookings.status,
      version: bookings.version,
      spaceId: bookings.spaceId,
      spaceName: spaces.name,
      spaceActive: spaces.isActive,
      slotKind: bookings.slotKind,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      blockedUntil: bookings.blockedUntil,
      tentativeExpiresAt: bookings.tentativeExpiresAt,
      customerId: customers.id,
      customerName: customers.name,
      customerPhone: customers.phone,
      customerAltPhone: customers.altPhone,
      eventTypeId: bookings.eventTypeId,
      eventTypeName: eventTypes.name,
      isWedding: eventTypes.isWedding,
      groomName: bookings.groomName,
      brideName: bookings.brideName,
      packageId: bookings.packageId,
      packageName: packages.name,
      guests: bookings.guests,
      seasonName: seasons.name,
      basePrice: bookings.basePrice,
      baseGuests: bookings.baseGuests,
      extraGuestPrice: bookings.extraGuestPrice,
      extraGuestsAmount: bookings.extraGuestsAmount,
      itemsTotal: bookings.itemsTotal,
      removalCreditsTotal: bookings.removalCreditsTotal,
      discountAmount: bookings.discountAmount,
      total: bookings.total,
      notes: bookings.notes,
      createdAt: bookings.createdAt,
      createdByName: users.name,
    })
    .from(bookings)
    .innerJoin(spaces, eq(spaces.id, bookings.spaceId))
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .innerJoin(users, eq(users.id, bookings.createdBy))
    .leftJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
    .leftJoin(packages, eq(packages.id, bookings.packageId))
    .leftJoin(seasons, eq(seasons.id, bookings.seasonId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, actor.venueId)));
  if (!row) throw notFound("bookingNotFound");

  const [lines, overlaps, history, money] = await Promise.all([
    db
      .select({
        id: bookingItems.id,
        serviceId: bookingItems.serviceId,
        name: bookingItems.name,
        category: bookingItems.category,
        pricingType: bookingItems.pricingType,
        unitPrice: bookingItems.unitPrice,
        quantity: bookingItems.quantity,
        source: bookingItems.source,
        isRemoved: bookingItems.isRemoved,
        removalCredit: bookingItems.removalCredit,
        isExternal: bookingItems.isExternal,
        externalFee: bookingItems.externalFee,
        lineTotal: bookingItems.lineTotal,
      })
      .from(bookingItems)
      .where(and(eq(bookingItems.bookingId, row.id), isNull(bookingItems.voidedAt)))
      .orderBy(asc(bookingItems.sortOrder)),
    findOverlapping(
      db,
      {
        venueId: actor.venueId,
        spaceId: row.spaceId,
        startsAt: row.startsAt,
        blockedUntil: row.blockedUntil,
        excludeBookingId: row.id,
      },
      now,
    ),
    db
      .select({
        id: auditLogs.id,
        at: auditLogs.createdAt,
        actorName: users.name,
        action: auditLogs.action,
        before: auditLogs.before,
        after: auditLogs.after,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(
        and(
          eq(auditLogs.venueId, actor.venueId),
          or(
            and(eq(auditLogs.entityType, "booking"), eq(auditLogs.entityId, row.id)),
            // Its payments (D-108): their audit rows carry the booking in `meta`.
            and(eq(auditLogs.entityType, "payment"), sql`${auditLogs.meta}->>'bookingId' = ${row.id}`),
            // And its discount requests (D-129).
            and(eq(auditLogs.entityType, "discount_request"), sql`${auditLogs.meta}->>'bookingId' = ${row.id}`),
          ),
        ),
      )
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)),
    bookingPayments(db, actor.venueId, row, now),
  ]);

  const status = displayStatus(row, now, row.status === "tentative" && overlaps.confirmed.length > 0);
  return {
    booking: {
      ...row,
      eventDate: cairoDate(row.startsAt),
      startTime: cairoTimeOfDay(row.startsAt),
      endTime: cairoTimeOfDay(row.endsAt),
      displayStatus: status,
    },
    lines,
    money,
    confirmedConflicts:
      row.status === "tentative" ? overlaps.confirmed.map(({ id, bookingNo }) => ({ id, bookingNo })) : [],
    history: history.map((h) => ({
      id: h.id,
      at: h.at,
      actorName: h.actorName,
      action: h.action,
      changes: changesOf(h.before, h.after),
    })),
  };
}

/** The fields of a snapshot that changed, for the booking's history tab (D-108). */
function changesOf(before: unknown, after: unknown) {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  if (!before) return [];
  return Object.keys(a)
    .filter((key) => JSON.stringify(b[key] ?? null) !== JSON.stringify(a[key] ?? null))
    .map((key) => ({ field: key, before: b[key] ?? null, after: a[key] ?? null }));
}

/**
 * What the booking wizard (S-06) chooses from: spaces with their slots, packages with their
 * bookable slots and included services, event types, services and the venue's timing.
 * Inactive rows come too, so a tentative booking that uses one still shows it.
 */
export async function getBookingFormOptions(db: DbOrTx, actor: SessionUser) {
  if (!satisfies(actor, "bookings.create") && !satisfies(actor, "bookings.edit")) throw forbidden();
  const venueId = actor.venueId;
  const [spaceRows, packageRows, eventTypeRows, serviceRows, timing] = await Promise.all([
    readSpaces(db, venueId),
    db
      .select({
        id: packages.id,
        spaceId: packages.spaceId,
        name: packages.name,
        description: packages.description,
        baseGuests: packages.baseGuests,
        extraGuestPrice: packages.extraGuestPrice,
        isActive: packages.isActive,
      })
      .from(packages)
      .where(eq(packages.venueId, venueId))
      .orderBy(asc(packages.name)),
    db
      .select({
        id: eventTypes.id,
        name: eventTypes.name,
        isWedding: eventTypes.isWedding,
        isActive: eventTypes.isActive,
      })
      .from(eventTypes)
      .where(eq(eventTypes.venueId, venueId))
      .orderBy(asc(eventTypes.sortOrder), asc(eventTypes.name)),
    readServices(db, venueId),
    getTiming(db, venueId),
  ]);
  const ids = packageRows.map((p) => p.id);
  const [prices, items] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              packageId: packagePrices.packageId,
              slotKind: packagePrices.slotKind,
              seasonId: packagePrices.seasonId,
              price: packagePrices.price,
            })
            .from(packagePrices)
            .where(inArray(packagePrices.packageId, ids)),
          db
            .select({
              packageId: packageItems.packageId,
              serviceId: packageItems.serviceId,
              quantity: packageItems.quantity,
              removable: packageItems.removable,
              removalCredit: packageItems.removalCredit,
            })
            .from(packageItems)
            .where(inArray(packageItems.packageId, ids))
            .orderBy(asc(packageItems.sortOrder)),
        ]);
  return {
    spaces: spaceRows,
    packages: packageRows.map((p) => ({
      ...p,
      bookableSlots: bookableSlotKinds(prices.filter((x) => x.packageId === p.id)),
      items: items
        .filter((i) => i.packageId === p.id)
        .map((i) => ({
          serviceId: i.serviceId,
          quantity: i.quantity,
          removable: i.removable,
          removalCredit: i.removalCredit,
        })),
    })),
    eventTypes: eventTypeRows,
    services: serviceRows,
    timing,
  };
}

export type BookingFormOptions = Awaited<ReturnType<typeof getBookingFormOptions>>;

/** The edit wizard: a tentative booking as the form's values, on the version it was opened on (D-101). */
export async function getTentativeForEdit(db: DbOrTx, actor: SessionUser, bookingId: string) {
  assertAllowed(actor, "bookings.edit");
  const [row] = await db
    .select({
      id: bookings.id,
      bookingNo: bookings.bookingNo,
      status: bookings.status,
      version: bookings.version,
      spaceId: bookings.spaceId,
      slotKind: bookings.slotKind,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      customerId: customers.id,
      customerName: customers.name,
      customerPhone: customers.phone,
      eventTypeId: bookings.eventTypeId,
      groomName: bookings.groomName,
      brideName: bookings.brideName,
      packageId: bookings.packageId,
      guests: bookings.guests,
      notes: bookings.notes,
    })
    .from(bookings)
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, actor.venueId)));
  if (!row) throw notFound("bookingNotFound");
  const lines = await db
    .select({
      serviceId: bookingItems.serviceId,
      quantity: bookingItems.quantity,
      pricingType: bookingItems.pricingType,
      source: bookingItems.source,
      isRemoved: bookingItems.isRemoved,
      isExternal: bookingItems.isExternal,
    })
    .from(bookingItems)
    .where(eq(bookingItems.bookingId, row.id))
    .orderBy(asc(bookingItems.sortOrder));
  return {
    ...row,
    eventDate: cairoDate(row.startsAt),
    startTime: cairoTimeOfDay(row.startsAt),
    endTime: cairoTimeOfDay(row.endsAt),
    items: lines
      .filter((l) => l.source === "added" && l.serviceId)
      .map((l) => ({ serviceId: l.serviceId!, quantity: requestedQuantity(l), isExternal: l.isExternal })),
    removedServiceIds: lines.filter((l) => l.isRemoved && l.serviceId).map((l) => l.serviceId!),
  };
}

export type TentativeForEdit = Awaited<ReturnType<typeof getTentativeForEdit>>;

/** Names for the list filters. */
export async function listSpaceNames(db: DbOrTx, actor: SessionUser) {
  assertAllowed(actor, "bookings.view");
  return db
    .select({ id: spaces.id, name: spaces.name, isActive: spaces.isActive })
    .from(spaces)
    .where(eq(spaces.venueId, actor.venueId))
    .orderBy(asc(spaces.sortOrder), asc(spaces.name));
}
