import { and, eq } from "drizzle-orm";
import { bookings, discountRequests } from "@/db/schema";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { recordTotalChange, type CreditChoice } from "@/modules/bookings/changes";
import { readBookingSnapshot } from "@/modules/bookings/service";
import type { ServiceDeps } from "@/modules/shared/context";
import type { Tx } from "@/modules/shared/db";
import { AppError, forbidden, notFound } from "@/modules/shared/errors";
import { runTransaction } from "@/modules/shared/transaction";
import { assertAllowed, satisfies } from "@/modules/users-rbac/authorize";
import type { DecideDiscountInput, RequestDiscountInput } from "./schemas";

/**
 * Discount requests (BR-50..52, UF-06, D-129). A pending request changes nothing; an approved
 * one lowers the total in the same transaction — on a confirmed booking with its change row,
 * schedule and credit (BR-42, BR-65, BR-83). Requested by someone who may approve, it is
 * approved at once with them as the approver (BR-51). Approved is final (Q7-03).
 */

type DiscountBooking = {
  id: string;
  bookingNo: string;
  status: "tentative" | "confirmed" | "cancelled";
  total: number | null;
  discountAmount: number | null;
  startsAt: Date;
  version: number;
};

/** The booking locked first, like every money operation on it (D-126). */
async function lockDiscountBooking(tx: Tx, venueId: string, bookingId: string): Promise<DiscountBooking> {
  const [row] = await tx
    .select({
      id: bookings.id,
      bookingNo: bookings.bookingNo,
      status: bookings.status,
      total: bookings.total,
      discountAmount: bookings.discountAmount,
      startsAt: bookings.startsAt,
      version: bookings.version,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, venueId)))
    .for("update");
  if (!row) throw notFound("bookingNotFound");
  return row;
}

/** Q7-01: a tentative booking with a package, or a confirmed one. */
function assertTakesDiscounts(booking: DiscountBooking) {
  if (booking.status === "cancelled") throw new AppError("BUSINESS_RULE_VIOLATION", "bookingCancelled");
  if (booking.total === null) throw new AppError("BUSINESS_RULE_VIOLATION", "discountNeedsPackage", { rule: "BR-50" });
}

/** BR-52: approved discounts never exceed the total before discounts, i.e. a new one never exceeds the total now. */
function assertWithinTotal(booking: DiscountBooking, amount: number) {
  if (amount > booking.total!) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "discountExceedsSubtotal", {
      rule: "BR-52",
      fieldErrors: { amount: "discountExceedsSubtotal" },
      details: { total: booking.total },
    });
  }
}

export type NewDiscount = {
  bookingId: string;
  amount: number;
  reason: string;
  source: "request" | "price_override";
  approved: boolean;
};

/** One request row and its audit row; an approved one carries its approver (BR-51). */
export async function insertDiscount(
  tx: Tx,
  actor: SessionUser,
  now: Date,
  booking: { bookingNo: string },
  d: NewDiscount,
) {
  const [row] = await tx
    .insert(discountRequests)
    .values({
      venueId: actor.venueId,
      bookingId: d.bookingId,
      amount: d.amount,
      reason: d.reason,
      source: d.source,
      status: d.approved ? "approved" : "pending",
      requestedBy: actor.userId,
      decidedBy: d.approved ? actor.userId : null,
      decidedAt: d.approved ? now : null,
    })
    .returning({ id: discountRequests.id });
  await recordAudit(tx, {
    venueId: actor.venueId,
    actorId: actor.userId,
    action: "discounts.request",
    entityType: "discount_request",
    entityId: row.id,
    after: {
      bookingNo: booking.bookingNo,
      amount: d.amount,
      reason: d.reason,
      status: d.approved ? "approved" : "pending",
    },
    meta: { bookingId: d.bookingId, source: d.source, ...(d.approved ? { direct: true } : {}) },
  });
  return row.id;
}

/**
 * The approved amount applied to the booking: `discount_amount` and `total` (D-85), the
 * version moves on; a confirmed booking records the change and settles its consequences.
 */
async function applyDiscount(
  tx: Tx,
  actor: SessionUser,
  now: Date,
  booking: DiscountBooking,
  amount: number,
  credit: CreditChoice | null,
) {
  const venueId = actor.venueId;
  const totalBefore = booking.total!;
  const totalAfter = totalBefore - amount;
  const before = booking.status === "confirmed" ? await readBookingSnapshot(tx, venueId, booking.id) : null;
  const [row] = await tx
    .update(bookings)
    .set({
      discountAmount: (booking.discountAmount ?? 0) + amount,
      total: totalAfter,
      version: booking.version + 1,
    })
    .where(eq(bookings.id, booking.id))
    .returning({ version: bookings.version });
  if (booking.status !== "confirmed") return { version: row.version, total: totalAfter, settled: null };
  const settled = await recordTotalChange(tx, actor, now, {
    booking,
    kind: "discount",
    before: { ...before, discountAmount: booking.discountAmount },
    after: {
      ...(await readBookingSnapshot(tx, venueId, booking.id)),
      discountAmount: (booking.discountAmount ?? 0) + amount,
    },
    totalBefore,
    totalAfter,
    credit,
  });
  return { version: row.version, total: totalAfter, settled };
}

/** `discounts.request` (BR-50, BR-51): pending, or applied at once for an approver. */
export async function requestDiscount(deps: ServiceDeps, actor: SessionUser, input: RequestDiscountInput) {
  assertAllowed(actor, "discounts.request");
  const direct = satisfies(actor, "discounts.approve");
  return runTransaction(deps.db, async (tx) => {
    const booking = await lockDiscountBooking(tx, actor.venueId, input.bookingId);
    assertTakesDiscounts(booking);
    assertWithinTotal(booking, input.amount);
    const requestId = await insertDiscount(tx, actor, deps.now, booking, {
      bookingId: booking.id,
      amount: input.amount,
      reason: input.reason,
      source: "request",
      approved: direct,
    });
    if (!direct) return { requestId, status: "pending" as const, version: booking.version, total: booking.total! };
    const applied = await applyDiscount(tx, actor, deps.now, booking, input.amount, input.credit);
    return { requestId, status: "approved" as const, ...applied, refund: applied.settled?.refund ?? null };
  });
}

async function lockRequest(tx: Tx, venueId: string, requestId: string) {
  const [found] = await tx
    .select({ bookingId: discountRequests.bookingId })
    .from(discountRequests)
    .where(and(eq(discountRequests.id, requestId), eq(discountRequests.venueId, venueId)));
  if (!found) throw notFound("discountNotFound");
  // The booking first, then the request (D-126).
  const booking = await lockDiscountBooking(tx, venueId, found.bookingId);
  const [request] = await tx
    .select({
      id: discountRequests.id,
      amount: discountRequests.amount,
      reason: discountRequests.reason,
      status: discountRequests.status,
      requestedBy: discountRequests.requestedBy,
    })
    .from(discountRequests)
    .where(eq(discountRequests.id, requestId))
    .for("update");
  if (request.status !== "pending") {
    throw new AppError("BUSINESS_RULE_VIOLATION", "discountAlreadyDecided", { rule: "D-129" });
  }
  return { booking, request };
}

/** `discounts.decide` (BR-50..52): approving checks BR-52 on the total now; rejecting changes nothing else. */
export async function decideDiscount(deps: ServiceDeps, actor: SessionUser, input: DecideDiscountInput) {
  assertAllowed(actor, "discounts.approve");
  return runTransaction(deps.db, async (tx) => {
    const { booking, request } = await lockRequest(tx, actor.venueId, input.requestId);
    if (input.approve) {
      assertTakesDiscounts(booking);
      assertWithinTotal(booking, request.amount);
    }
    await tx
      .update(discountRequests)
      .set({
        status: input.approve ? "approved" : "rejected",
        decidedBy: actor.userId,
        decidedAt: deps.now,
        decisionNote: input.note,
      })
      .where(eq(discountRequests.id, request.id));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: input.approve ? "discounts.approve" : "discounts.reject",
      entityType: "discount_request",
      entityId: request.id,
      before: { bookingNo: booking.bookingNo, amount: request.amount, reason: request.reason, status: "pending" },
      after: { status: input.approve ? "approved" : "rejected", note: input.note },
      meta: { bookingId: booking.id },
    });
    if (!input.approve) return { status: "rejected" as const, version: booking.version, total: booking.total };
    const applied = await applyDiscount(tx, actor, deps.now, booking, request.amount, input.credit);
    return { status: "approved" as const, ...applied, refund: applied.settled?.refund ?? null };
  });
}

/** `discounts.withdraw` (Q7-03): a pending request, by the one who asked or an approver. */
export async function withdrawDiscount(deps: ServiceDeps, actor: SessionUser, input: { requestId: string }) {
  if (!satisfies(actor, "discounts.request") && !satisfies(actor, "discounts.approve")) throw forbidden();
  return runTransaction(deps.db, async (tx) => {
    const { booking, request } = await lockRequest(tx, actor.venueId, input.requestId);
    if (request.requestedBy !== actor.userId && !satisfies(actor, "discounts.approve")) {
      throw forbidden("discountNotYours", "Q7-03");
    }
    await tx
      .update(discountRequests)
      .set({ status: "withdrawn", decidedBy: actor.userId, decidedAt: deps.now })
      .where(eq(discountRequests.id, request.id));
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "discounts.withdraw",
      entityType: "discount_request",
      entityId: request.id,
      before: { bookingNo: booking.bookingNo, amount: request.amount, status: "pending" },
      after: { status: "withdrawn" },
      meta: { bookingId: booking.id },
    });
    return { status: "withdrawn" as const };
  });
}
