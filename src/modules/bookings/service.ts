import { and, eq } from "drizzle-orm";
import { bookingItems, bookings, customers, eventTypes, packages, spaces } from "@/db/schema";
import { bookingDateViolation, bookingTimes, type BookingTimes } from "@/domain/booking-time";
import type { PriceBreakdown } from "@/domain/pricing";
import { addMs, cairoDate, cairoTimeOfDay, cairoYear, MINUTE_MS } from "@/lib/time";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { insertCustomer, readCustomer } from "@/modules/customers/service";
import { quoteForVenue } from "@/modules/pricing/service";
import { getTiming } from "@/modules/settings/venue";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { runTransaction } from "@/modules/shared/transaction";
import { AppError, notFound, validationError } from "@/modules/shared/errors";
import { lockSpaceRow, readSpaceWithTiming, type Space } from "@/modules/spaces/service";
import { assertAllowed } from "@/modules/users-rbac/authorize";
import { findOverlapping, nextBookingNumber } from "./repository";
import type { BookingInput, UpdateDetailsInput, UpdateTentativeInput } from "./schemas";

/**
 * Tentative bookings (BR-20, D-08, D-09) and their edits (D-101). Each operation is one
 * transaction with its audit row (CLAUDE.md rule 7). Confirming is phase 6 (D-97).
 *
 * Saving a booking: the space (active, share-locked — BR-06, C-08), its times from the
 * slots and the current buffer (BR-03, BR-04, BR-10, D-100, D-110), the date window
 * (BR-27), the capacity (BR-05), the price from the current catalog stored exactly as
 * quoted (D-87, D-103), the customer (D-28), the number (BR-26), then the warnings for
 * overlapping bookings (BR-12, D-08, D-102).
 */

const HOUR_MS = 60 * MINUTE_MS;

export type OverlapWarning = { id: string; bookingNo: string; startsAt: Date; endsAt: Date };
export type BookingWarnings = { confirmedConflicts: OverlapWarning[]; tentativeOverlaps: OverlapWarning[] };

/** The space share-locked for the transaction (C-08), with its slots and the venue's timing. */
async function loadSpace(tx: Tx, venueId: string, spaceId: string) {
  await lockSpaceRow(tx, venueId, spaceId, "share");
  return readSpaceWithTiming(tx, venueId, spaceId);
}

const TIME_ERRORS = {
  sameStartEnd: "timesSame",
  endBeforeStart: "timesEndBeforeStart",
  tooLong: "timesTooLong",
} as const;

/** BR-03, BR-04 (D-37, D-100), BR-10 with the buffer now (D-110). */
export function resolveTimes(
  space: Space,
  input: Pick<BookingInput, "eventDate" | "slotKind" | "startTime" | "endTime">,
  bufferMinutes: number,
): BookingTimes {
  const result = bookingTimes({ ...input, slots: space, bufferMinutes });
  if (!result.ok) throw validationError({ endTime: TIME_ERRORS[result.violation] });
  return result.times;
}

function assertDateWindow(eventDate: string, startsAt: Date, now: Date) {
  const violation = bookingDateViolation(eventDate, startsAt, now);
  if (violation) {
    throw new AppError("BUSINESS_RULE_VIOLATION", violation, {
      rule: "BR-27",
      fieldErrors: { [violation === "startPassed" ? "startTime" : "eventDate"]: violation },
    });
  }
}

function assertActiveSpace(space: Space) {
  if (!space.isActive) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "spaceInactiveForBooking", {
      rule: "BR-06",
      fieldErrors: { spaceId: "spaceInactiveForBooking" },
    });
  }
}

/** BR-05: never more guests than the space's capacity, when it has one. */
function assertCapacity(space: Space, guests: number | null) {
  if (guests !== null && space.capacityMax !== null && guests > space.capacityMax) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "overCapacity", {
      rule: "BR-05",
      fieldErrors: { guests: "overCapacity" },
    });
  }
}

/** An inactive event type is not chosen again; one already on the booking may stay (`keep`). */
async function assertEventType(tx: Tx, venueId: string, eventTypeId: string | null, keep: string | null) {
  if (!eventTypeId) return;
  const [row] = await tx
    .select({ isActive: eventTypes.isActive })
    .from(eventTypes)
    .where(and(eq(eventTypes.id, eventTypeId), eq(eventTypes.venueId, venueId)));
  if (!row) throw notFound("eventTypeNotFound");
  if (!row.isActive && eventTypeId !== keep) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "eventTypeInactive", {
      fieldErrors: { eventTypeId: "eventTypeInactive" },
    });
  }
}

/** The current catalog's quote (D-87), or nothing without a package (D-103). */
async function priceFor(tx: Tx, venueId: string, input: BookingInput): Promise<PriceBreakdown | null> {
  if (!input.packageId || input.guests === null) return null;
  return quoteForVenue(tx, venueId, {
    spaceId: input.spaceId,
    packageId: input.packageId,
    slotKind: input.slotKind,
    eventDate: input.eventDate,
    guests: input.guests,
    items: input.items,
    removedServiceIds: input.removedServiceIds,
    discountAmount: 0,
  });
}

/** The breakdown in the booking's columns, as is (PHASE4_PLAN §3). */
function priceColumns(price: PriceBreakdown | null) {
  return {
    seasonId: price?.seasonId ?? null,
    basePrice: price?.basePrice ?? null,
    extraGuestsAmount: price?.extraGuestsAmount ?? null,
    itemsTotal: price?.itemsTotal ?? null,
    removalCreditsTotal: price?.removalCreditsTotal ?? null,
    discountAmount: price?.discountAmount ?? null,
    total: price?.total ?? null,
    baseGuests: price?.baseGuests ?? null,
    extraGuestPrice: price?.extraGuestPrice ?? null,
  };
}

async function insertLines(tx: Tx, venueId: string, bookingId: string, price: PriceBreakdown | null) {
  if (!price || price.lines.length === 0) return;
  await tx.insert(bookingItems).values(
    price.lines.map((line, index) => ({
      venueId,
      bookingId,
      serviceId: line.serviceId,
      name: line.name,
      category: line.category,
      pricingType: line.pricingType,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
      source: line.source,
      isRemoved: line.isRemoved,
      removalCredit: line.removalCredit,
      isExternal: line.isExternal,
      externalFee: line.externalFee,
      lineTotal: line.lineTotal,
      sortOrder: index,
    })),
  );
}

async function resolveCustomer(tx: Tx, actor: SessionUser, choice: BookingInput["customer"]): Promise<string> {
  if ("customerId" in choice) {
    await readCustomer(tx, actor.venueId, choice.customerId);
    return choice.customerId;
  }
  return insertCustomer(tx, actor.venueId, actor.userId, { ...choice, notes: null });
}

async function overlapWarnings(
  db: DbOrTx,
  venueId: string,
  spaceId: string,
  times: Pick<BookingTimes, "startsAt" | "blockedUntil">,
  now: Date,
  excludeBookingId: string | null,
): Promise<BookingWarnings> {
  const found = await findOverlapping(db, { venueId, spaceId, ...times, excludeBookingId }, now);
  const pick = ({ id, bookingNo, startsAt, endsAt }: OverlapWarning) => ({ id, bookingNo, startsAt, endsAt });
  return { confirmedConflicts: found.confirmed.map(pick), tentativeOverlaps: found.tentative.map(pick) };
}

const cairoStamp = (instant: Date | null) => (instant ? `${cairoDate(instant)} ${cairoTimeOfDay(instant)}` : null);

/** What the audit log and the booking's history show (D-108): names and Cairo times, not ids. */
export async function readBookingSnapshot(db: DbOrTx, venueId: string, bookingId: string) {
  const [row] = await db
    .select({
      bookingNo: bookings.bookingNo,
      status: bookings.status,
      space: spaces.name,
      slotKind: bookings.slotKind,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      customerName: customers.name,
      customerPhone: customers.phone,
      eventType: eventTypes.name,
      groomName: bookings.groomName,
      brideName: bookings.brideName,
      package: packages.name,
      guests: bookings.guests,
      total: bookings.total,
      tentativeExpiresAt: bookings.tentativeExpiresAt,
      notes: bookings.notes,
    })
    .from(bookings)
    .innerJoin(spaces, eq(spaces.id, bookings.spaceId))
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .leftJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
    .leftJoin(packages, eq(packages.id, bookings.packageId))
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, venueId)));
  if (!row) throw notFound("bookingNotFound");
  const lines = await db
    .select({
      name: bookingItems.name,
      quantity: bookingItems.quantity,
      source: bookingItems.source,
      isRemoved: bookingItems.isRemoved,
      isExternal: bookingItems.isExternal,
    })
    .from(bookingItems)
    .where(eq(bookingItems.bookingId, bookingId))
    .orderBy(bookingItems.sortOrder);
  return {
    bookingNo: row.bookingNo,
    status: row.status,
    space: row.space,
    slotKind: row.slotKind,
    startsAt: cairoStamp(row.startsAt),
    endsAt: cairoStamp(row.endsAt),
    customer: `${row.customerName} (${row.customerPhone})`,
    eventType: row.eventType,
    groomName: row.groomName,
    brideName: row.brideName,
    package: row.package,
    guests: row.guests,
    total: row.total,
    removed: lines.filter((l) => l.isRemoved).map((l) => l.name),
    added: lines
      .filter((l) => l.source !== "package")
      .map((l) => `${l.name} ×${l.quantity}${l.isExternal ? " (خارجي)" : ""}`),
    tentativeExpiresAt: cairoStamp(row.tentativeExpiresAt),
    notes: row.notes,
  };
}

/** `bookings.createTentative` (BR-20, D-09, D-101). */
export async function createTentative(deps: ServiceDeps, actor: SessionUser, input: BookingInput) {
  assertAllowed(actor, "bookings.create");
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const { space, timing } = await loadSpace(tx, venueId, input.spaceId);
    assertActiveSpace(space);
    const times = resolveTimes(space, input, timing.bufferMinutes);
    assertDateWindow(input.eventDate, times.startsAt, deps.now);
    await assertEventType(tx, venueId, input.eventTypeId, null);
    assertCapacity(space, input.guests);
    const price = await priceFor(tx, venueId, input);
    const customerId = await resolveCustomer(tx, actor, input.customer);
    const bookingNo = await nextBookingNumber(tx, venueId, cairoYear(deps.now));
    const tentativeExpiresAt = addMs(deps.now, timing.tentativeHoldHours * HOUR_MS);

    const [row] = await tx
      .insert(bookings)
      .values({
        venueId,
        bookingNo,
        spaceId: space.id,
        customerId,
        eventTypeId: input.eventTypeId,
        groomName: input.groomName,
        brideName: input.brideName,
        slotKind: input.slotKind,
        startsAt: times.startsAt,
        endsAt: times.endsAt,
        blockedUntil: times.blockedUntil,
        guests: input.guests,
        packageId: price ? input.packageId : null,
        status: "tentative",
        tentativeExpiresAt,
        ...priceColumns(price),
        notes: input.notes,
        createdBy: actor.userId,
      })
      .returning({ id: bookings.id, version: bookings.version });
    await insertLines(tx, venueId, row.id, price);

    const warnings = await overlapWarnings(tx, venueId, space.id, times, deps.now, row.id);
    await recordAudit(tx, {
      venueId,
      actorId: actor.userId,
      action: "bookings.create_tentative",
      entityType: "booking",
      entityId: row.id,
      after: await readBookingSnapshot(tx, venueId, row.id),
    });
    return { id: row.id, bookingNo, version: row.version, tentativeExpiresAt, warnings };
  });
}

/** The booking row locked for the rest of the transaction, checked against the version the page opened. */
async function lockBooking(tx: Tx, venueId: string, bookingId: string, version: number) {
  const [row] = await tx
    .select({
      id: bookings.id,
      status: bookings.status,
      version: bookings.version,
      spaceId: bookings.spaceId,
      slotKind: bookings.slotKind,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      packageId: bookings.packageId,
      guests: bookings.guests,
      eventTypeId: bookings.eventTypeId,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, venueId)))
    .for("update");
  if (!row) throw notFound("bookingNotFound");
  if (row.version !== version) throw new AppError("CONCURRENT_MODIFICATION", "bookingChanged");
  return row;
}

function assertTentative(status: string) {
  if (status !== "tentative") throw new AppError("BUSINESS_RULE_VIOLATION", "bookingNotTentative", { rule: "D-101" });
}

/** The added and removed services a booking was priced with, in a comparable form. */
async function storedChoices(tx: Tx, bookingId: string) {
  const lines = await tx
    .select({
      serviceId: bookingItems.serviceId,
      quantity: bookingItems.quantity,
      source: bookingItems.source,
      isRemoved: bookingItems.isRemoved,
      isExternal: bookingItems.isExternal,
    })
    .from(bookingItems)
    .where(eq(bookingItems.bookingId, bookingId));
  return {
    added: choiceKey(lines.filter((l) => l.source === "added")),
    removed: [...lines.filter((l) => l.isRemoved).map((l) => l.serviceId ?? "")].sort().join(","),
  };
}

const choiceKey = (items: { serviceId: string | null; quantity: number; isExternal: boolean }[]) =>
  items
    .map((i) => `${i.serviceId}:${i.quantity}:${i.isExternal}`)
    .sort()
    .join(",");

/**
 * `bookings.updateTentative` (D-101): every field of a tentative booking, expired or not.
 * The times always take the current buffer (D-110); the price is re-quoted only when one
 * of its inputs changed; `tentative_expires_at` is kept. Moving it — or changing what
 * prices it — needs an active space (D-112).
 */
export async function updateTentative(deps: ServiceDeps, actor: SessionUser, input: UpdateTentativeInput) {
  assertAllowed(actor, "bookings.edit");
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const current = await lockBooking(tx, venueId, input.bookingId, input.version);
    assertTentative(current.status);
    const before = await readBookingSnapshot(tx, venueId, current.id);
    const stored = await storedChoices(tx, current.id);

    const { space, timing } = await loadSpace(tx, venueId, input.spaceId);
    const times = resolveTimes(space, input, timing.bufferMinutes);
    const moved =
      input.spaceId !== current.spaceId ||
      input.slotKind !== current.slotKind ||
      times.startsAt.getTime() !== current.startsAt.getTime() ||
      times.endsAt.getTime() !== current.endsAt.getTime();
    const repriced =
      input.spaceId !== current.spaceId ||
      input.slotKind !== current.slotKind ||
      input.eventDate !== cairoDate(current.startsAt) ||
      input.packageId !== current.packageId ||
      input.guests !== current.guests ||
      choiceKey(input.items) !== stored.added ||
      [...input.removedServiceIds].sort().join(",") !== stored.removed;

    if (moved || repriced) assertActiveSpace(space);
    if (moved) assertDateWindow(input.eventDate, times.startsAt, deps.now);
    await assertEventType(tx, venueId, input.eventTypeId, current.eventTypeId);
    if (input.guests !== current.guests || input.spaceId !== current.spaceId) assertCapacity(space, input.guests);
    const price = repriced ? await priceFor(tx, venueId, input) : undefined;
    const customerId = await resolveCustomer(tx, actor, input.customer);

    const [row] = await tx
      .update(bookings)
      .set({
        spaceId: space.id,
        customerId,
        eventTypeId: input.eventTypeId,
        groomName: input.groomName,
        brideName: input.brideName,
        slotKind: input.slotKind,
        startsAt: times.startsAt,
        endsAt: times.endsAt,
        blockedUntil: times.blockedUntil,
        guests: input.guests,
        notes: input.notes,
        ...(price === undefined ? {} : { packageId: price ? input.packageId : null, ...priceColumns(price) }),
        version: current.version + 1,
      })
      .where(eq(bookings.id, current.id))
      .returning({ version: bookings.version });
    if (price !== undefined) {
      await tx.delete(bookingItems).where(eq(bookingItems.bookingId, current.id));
      await insertLines(tx, venueId, current.id, price);
    }

    const warnings = await overlapWarnings(tx, venueId, space.id, times, deps.now, current.id);
    await recordAudit(tx, {
      venueId,
      actorId: actor.userId,
      action: "bookings.update_tentative",
      entityType: "booking",
      entityId: current.id,
      before,
      after: await readBookingSnapshot(tx, venueId, current.id),
    });
    return { version: row.version, warnings };
  });
}

/** `bookings.extendTentative` (D-101): the hold restarts from now for `tentative_hold_hours`. */
export async function extendTentative(
  deps: ServiceDeps,
  actor: SessionUser,
  input: { bookingId: string; version: number },
) {
  assertAllowed(actor, "bookings.edit");
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const current = await lockBooking(tx, venueId, input.bookingId, input.version);
    assertTentative(current.status);
    const before = await readBookingSnapshot(tx, venueId, current.id);
    const timing = await getTiming(tx, venueId);
    const tentativeExpiresAt = addMs(deps.now, timing.tentativeHoldHours * HOUR_MS);
    const [row] = await tx
      .update(bookings)
      .set({ tentativeExpiresAt, version: current.version + 1 })
      .where(eq(bookings.id, current.id))
      .returning({ version: bookings.version });
    await recordAudit(tx, {
      venueId,
      actorId: actor.userId,
      action: "bookings.extend_tentative",
      entityType: "booking",
      entityId: current.id,
      before: { tentativeExpiresAt: before.tentativeExpiresAt },
      after: { tentativeExpiresAt: cairoStamp(tentativeExpiresAt) },
    });
    return { version: row.version, tentativeExpiresAt };
  });
}

/** `bookings.updateDetails` (API.md): non-financial data of any booking that is not cancelled. */
export async function updateDetails(deps: ServiceDeps, actor: SessionUser, input: UpdateDetailsInput) {
  assertAllowed(actor, "bookings.edit");
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const current = await lockBooking(tx, venueId, input.bookingId, input.version);
    if (current.status === "cancelled") throw new AppError("BUSINESS_RULE_VIOLATION", "bookingCancelled");
    const before = await readBookingSnapshot(tx, venueId, current.id);
    await assertEventType(tx, venueId, input.eventTypeId, current.eventTypeId);
    await readCustomer(tx, venueId, input.customerId);
    const [row] = await tx
      .update(bookings)
      .set({
        customerId: input.customerId,
        eventTypeId: input.eventTypeId,
        groomName: input.groomName,
        brideName: input.brideName,
        notes: input.notes,
        version: current.version + 1,
      })
      .where(eq(bookings.id, current.id))
      .returning({ version: bookings.version });
    await recordAudit(tx, {
      venueId,
      actorId: actor.userId,
      action: "bookings.update_details",
      entityType: "booking",
      entityId: current.id,
      before,
      after: await readBookingSnapshot(tx, venueId, current.id),
    });
    return { version: row.version };
  });
}
