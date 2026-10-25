import { and, eq } from "drizzle-orm";
import { bookings, packagePrices, seasons } from "@/db/schema";
import { lateInstallments, postponedSchedule } from "@/domain/cancellation";
import type { SlotKind } from "@/domain/catalog";
import { resolveBasePrice } from "@/domain/pricing";
import { cairoDate } from "@/lib/time";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { readLedgerRows, readSchedule } from "@/modules/payments/repository";
import { activeDeposit } from "@/domain/payments";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx } from "@/modules/shared/db";
import { AppError, notFound, pgError } from "@/modules/shared/errors";
import { runTransaction } from "@/modules/shared/transaction";
import { readSpaceWithTiming } from "@/modules/spaces/service";
import { assertAllowed } from "@/modules/users-rbac/authorize";
import { creditOutlook, recordTotalChange } from "./changes";
import { queueOnSpace } from "./space-queue";
import { findOverlapping } from "./repository";
import type { PostponeInput, PostponePreviewInput } from "./schemas";
import { assertActiveSpace, assertDateWindow, loadSpace, readBookingSnapshot, resolveTimes } from "./service";

/**
 * `bookings.postponePreview` and `bookings.postpone` (BR-80..85, UF-08, D-94, Q8-06). A
 * confirmed booking that is not over moves to a new date and slot of the same space (P8-05):
 * only `base_price` and `season_id` change, by the package's prices now (BR-81); everything
 * else keeps the prices on the booking. The new slot is the constraint's call (BR-11); the
 * difference goes through the same path as every other change of the total (D-131), and
 * installments due after the new eve must be moved first (BR-84). The cancellation policy
 * fixed at confirmation stays (D-68).
 */

const postponeColumns = {
  id: bookings.id,
  bookingNo: bookings.bookingNo,
  status: bookings.status,
  version: bookings.version,
  spaceId: bookings.spaceId,
  packageId: bookings.packageId,
  slotKind: bookings.slotKind,
  startsAt: bookings.startsAt,
  endsAt: bookings.endsAt,
  basePrice: bookings.basePrice,
  seasonId: bookings.seasonId,
  discountAmount: bookings.discountAmount,
  total: bookings.total,
};

async function readPostponeBooking(db: DbOrTx, venueId: string, bookingId: string, lock: boolean, now: Date) {
  const query = db
    .select(postponeColumns)
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, venueId)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("bookingNotFound");
  // BR-80: confirmed only, and not once the party is over.
  if (row.status !== "confirmed")
    throw new AppError("BUSINESS_RULE_VIOLATION", "postponeNotConfirmed", { rule: "BR-80" });
  if (row.endsAt <= now) throw new AppError("BUSINESS_RULE_VIOLATION", "bookingCompleted", { rule: "BR-80" });
  return row as typeof row & { packageId: string; basePrice: number; total: number };
}

type PostponeBooking = Awaited<ReturnType<typeof readPostponeBooking>>;

/** BR-81 (D-94): the package's price now for the new slot and its season, even if the package is inactive now. */
async function newBasePrice(db: DbOrTx, venueId: string, packageId: string, slotKind: SlotKind, date: string) {
  const [prices, activeSeasons] = await Promise.all([
    db
      .select({ slotKind: packagePrices.slotKind, seasonId: packagePrices.seasonId, price: packagePrices.price })
      .from(packagePrices)
      .where(eq(packagePrices.packageId, packageId)),
    db
      .select({ id: seasons.id, startDate: seasons.startDate, endDate: seasons.endDate, name: seasons.name })
      .from(seasons)
      .where(and(eq(seasons.venueId, venueId), eq(seasons.isActive, true))),
  ]);
  const resolved = resolveBasePrice(prices, slotKind, date, activeSeasons);
  if (!resolved) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "slotNotPriced", {
      rule: "D-56",
      fieldErrors: { slotKind: "slotNotPriced" },
    });
  }
  const seasonName = activeSeasons.find((s) => s.id === resolved.seasonId)?.name ?? null;
  return { basePrice: resolved.basePrice, seasonId: resolved.seasonId, seasonName };
}

/** What both the preview and the save compute: the new slot, its price and what follows from it. */
async function computePostponement(
  db: DbOrTx,
  venueId: string,
  booking: PostponeBooking,
  input: PostponePreviewInput,
  space: Awaited<ReturnType<typeof readSpaceWithTiming>>,
  now: Date,
) {
  // BR-06, BR-04 (D-37), BR-10 with the buffer now, BR-27.
  assertActiveSpace(space.space);
  const times = resolveTimes(space.space, input, space.timing.bufferMinutes);
  assertDateWindow(input.eventDate, times.startsAt, now);
  if (
    times.startsAt.getTime() === booking.startsAt.getTime() &&
    times.endsAt.getTime() === booking.endsAt.getTime() &&
    input.slotKind === booking.slotKind
  ) {
    throw new AppError("VALIDATION_ERROR", "nothingChanged");
  }

  const price = await newBasePrice(db, venueId, booking.packageId, input.slotKind, input.eventDate);
  const discount = booking.discountAmount ?? 0;
  const subtotalAfter = booking.total + discount - booking.basePrice + price.basePrice;
  if (subtotalAfter < 0) throw new AppError("BUSINESS_RULE_VIOLATION", "negativeTotal", { rule: "BR-35" });
  if (discount > subtotalAfter) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "discountExceedsSubtotal", { rule: "BR-52" });
  }
  const totalAfter = subtotalAfter - discount;

  const [schedule, ledgerRows, overlaps] = await Promise.all([
    readSchedule(db, booking.id),
    readLedgerRows(db, booking.id),
    findOverlapping(
      db,
      {
        venueId,
        spaceId: booking.spaceId,
        startsAt: times.startsAt,
        blockedUntil: times.blockedUntil,
        excludeBookingId: booking.id,
      },
      now,
    ),
  ]);
  const deposit = activeDeposit(ledgerRows)?.amount ?? 0;
  const late = lateInstallments(schedule, input.eventDate);
  const suggestedSchedule =
    schedule.length > 0 ? (postponedSchedule(schedule, input.eventDate, Math.max(0, totalAfter - deposit)) ?? []) : [];
  return { times, price, totalAfter, schedule, late, suggestedSchedule, overlaps };
}

/** `bookings.postponePreview` (`bookings.postpone`, read-only). */
export async function postponePreview(db: DbOrTx, actor: SessionUser, input: PostponePreviewInput, now: Date) {
  assertAllowed(actor, "bookings.postpone");
  const booking = await readPostponeBooking(db, actor.venueId, input.bookingId, false, now);
  const space = await readSpaceWithTiming(db, actor.venueId, booking.spaceId);
  const c = await computePostponement(db, actor.venueId, booking, input, space, now);
  const outlook = await creditOutlook(db, actor.venueId, booking.id, c.totalAfter);
  return {
    version: booking.version,
    startsAt: c.times.startsAt,
    endsAt: c.times.endsAt,
    basePriceBefore: booking.basePrice,
    basePriceAfter: c.price.basePrice,
    seasonName: c.price.seasonName,
    totalBefore: booking.total,
    totalAfter: c.totalAfter,
    paid: outlook.paid,
    credit: c.totalAfter < booking.total ? outlook.credit : 0,
    creditMode: outlook.mode,
    installments: c.schedule,
    lateInstallments: c.late,
    suggestedInstallments: c.suggestedSchedule,
    confirmedConflicts: c.overlaps.confirmed.map(({ id, bookingNo }) => ({ id, bookingNo })),
    tentativeOverlaps: c.overlaps.tentative.map(({ id, bookingNo }) => ({ id, bookingNo })),
  };
}

export type PostponePreview = Awaited<ReturnType<typeof postponePreview>>;

/** `bookings.postpone` (+ `payments.refund` when a credit is refunded): one transaction. */
export async function postponeBooking(deps: ServiceDeps, actor: SessionUser, input: PostponeInput) {
  assertAllowed(actor, "bookings.postpone");
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const [head] = await tx
      .select({ spaceId: bookings.spaceId })
      .from(bookings)
      .where(and(eq(bookings.id, input.bookingId), eq(bookings.venueId, venueId)));
    if (!head) throw notFound("bookingNotFound");
    // D-115: behind any other change of the space's confirmed bookings, before the row lock.
    await queueOnSpace(tx, head.spaceId);
    const booking = await readPostponeBooking(tx, venueId, input.bookingId, true, deps.now);
    if (booking.version !== input.version) throw new AppError("CONCURRENT_MODIFICATION", "bookingChanged");
    const space = await loadSpace(tx, venueId, booking.spaceId);
    const c = await computePostponement(tx, venueId, booking, input, space, deps.now);

    // BR-84 (Q8-06): installments after the new eve are moved by the staff member first.
    if (input.installments === undefined && c.late.length > 0) {
      throw new AppError("BUSINESS_RULE_VIOLATION", "installmentsAfterNewDate", {
        rule: "BR-84",
        fieldErrors: { installments: "installmentsAfterNewDate" },
        details: { suggested: c.suggestedSchedule },
      });
    }
    if (c.totalAfter !== input.expectedTotal) {
      throw new AppError("PRICE_CHANGED", "priceChanged", {
        rule: "BR-81",
        details: { total: c.totalAfter, expectedTotal: input.expectedTotal },
      });
    }

    const before = {
      ...(await readBookingSnapshot(tx, venueId, booking.id)),
      basePrice: booking.basePrice,
      seasonId: booking.seasonId,
    };
    let version: number;
    try {
      const [row] = await tx
        .update(bookings)
        .set({
          slotKind: input.slotKind,
          startsAt: c.times.startsAt,
          endsAt: c.times.endsAt,
          blockedUntil: c.times.blockedUntil,
          basePrice: c.price.basePrice,
          seasonId: c.price.seasonId,
          total: c.totalAfter,
          version: booking.version + 1,
        })
        .where(eq(bookings.id, booking.id))
        .returning({ version: bookings.version });
      version = row.version;
    } catch (error) {
      if (pgError(error).code === "23P01") throw new AppError("CONFLICT_SLOT_TAKEN", "slotTaken", { rule: "BR-11" });
      throw error;
    }

    const after = {
      ...(await readBookingSnapshot(tx, venueId, booking.id)),
      basePrice: c.price.basePrice,
      seasonId: c.price.seasonId,
    };
    const settled = await recordTotalChange(tx, actor, deps.now, {
      booking: { id: booking.id, bookingNo: booking.bookingNo, startsAt: c.times.startsAt },
      kind: "postpone",
      before,
      after,
      totalBefore: booking.total,
      totalAfter: c.totalAfter,
      installments: input.installments,
      credit: input.credit,
    });
    await recordAudit(tx, {
      venueId,
      actorId: actor.userId,
      action: "bookings.postpone",
      entityType: "booking",
      entityId: booking.id,
      before,
      after,
      meta: {
        changeId: settled.changeId,
        eventDateBefore: cairoDate(booking.startsAt),
        ...(settled.credit > 0 ? { credit: settled.credit, creditResolution: settled.creditResolution } : {}),
      },
    });
    return {
      version,
      total: c.totalAfter,
      credit: settled.credit,
      creditResolution: settled.creditResolution,
      refund: settled.refund,
      installments: settled.installments,
    };
  });
}
