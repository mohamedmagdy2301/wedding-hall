import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { bookings, customers, discountRequests, payments, users } from "@/db/schema";
import { netPaid } from "@/domain/payments";
import { cairoDate } from "@/lib/time";
import type { SessionUser } from "@/modules/auth/sessions";
import type { DbOrTx } from "@/modules/shared/db";
import { assertAllowed } from "@/modules/users-rbac/authorize";

/** Reads for the discounts section of S-07 and the approvals screen S-10 (D-129). */

const requester = alias(users, "requester");
const decider = alias(users, "decider");

/** S-07 (`bookings.view`): every request of the booking, newest first. */
export async function bookingDiscounts(db: DbOrTx, venueId: string, bookingId: string) {
  return db
    .select({
      id: discountRequests.id,
      amount: discountRequests.amount,
      reason: discountRequests.reason,
      source: discountRequests.source,
      status: discountRequests.status,
      requestedById: discountRequests.requestedBy,
      requestedByName: requester.name,
      createdAt: discountRequests.createdAt,
      decidedByName: decider.name,
      decidedAt: discountRequests.decidedAt,
      decisionNote: discountRequests.decisionNote,
    })
    .from(discountRequests)
    .innerJoin(requester, eq(requester.id, discountRequests.requestedBy))
    .leftJoin(decider, eq(decider.id, discountRequests.decidedBy))
    .where(and(eq(discountRequests.bookingId, bookingId), eq(discountRequests.venueId, venueId)))
    .orderBy(desc(discountRequests.createdAt), desc(discountRequests.id));
}

export type BookingDiscount = Awaited<ReturnType<typeof bookingDiscounts>>[number];

/**
 * S-10 (`discounts.approve`): pending requests, oldest first, with what approving would leave —
 * the total after it and the customer's credit when paid would exceed it (BR-83).
 */
export async function listPendingDiscounts(db: DbOrTx, actor: SessionUser) {
  assertAllowed(actor, "discounts.approve");
  const rows = await db
    .select({
      id: discountRequests.id,
      amount: discountRequests.amount,
      reason: discountRequests.reason,
      source: discountRequests.source,
      createdAt: discountRequests.createdAt,
      requestedByName: requester.name,
      bookingId: bookings.id,
      bookingNo: bookings.bookingNo,
      bookingStatus: bookings.status,
      startsAt: bookings.startsAt,
      total: bookings.total,
      customerName: customers.name,
    })
    .from(discountRequests)
    .innerJoin(requester, eq(requester.id, discountRequests.requestedBy))
    .innerJoin(bookings, eq(bookings.id, discountRequests.bookingId))
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .where(and(eq(discountRequests.venueId, actor.venueId), eq(discountRequests.status, "pending")))
    .orderBy(asc(discountRequests.createdAt), asc(discountRequests.id));
  const ids = [...new Set(rows.filter((r) => r.bookingStatus === "confirmed").map((r) => r.bookingId))];
  const paidRows =
    ids.length === 0
      ? []
      : await db
          .select({ bookingId: payments.bookingId, kind: payments.kind, amount: payments.amount })
          .from(payments)
          .where(and(inArray(payments.bookingId, ids), isNull(payments.voidedAt)));
  return rows.map((r) => {
    const paid =
      r.bookingStatus === "confirmed"
        ? netPaid(paidRows.filter((p) => p.bookingId === r.bookingId).map((p) => ({ ...p, voided: false })))
        : 0;
    const totalAfter = r.total === null ? null : r.total - r.amount;
    return {
      ...r,
      eventDate: cairoDate(r.startsAt),
      totalAfter,
      credit: totalAfter === null ? 0 : Math.max(0, paid - Math.max(totalAfter, 0)),
      fits: r.total !== null && r.amount <= r.total,
    };
  });
}

export type PendingDiscount = Awaited<ReturnType<typeof listPendingDiscounts>>[number];

/** The badge on the approvals link. */
export async function pendingDiscountCount(db: DbOrTx, venueId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(discountRequests)
    .where(and(eq(discountRequests.venueId, venueId), eq(discountRequests.status, "pending")));
  return row.n;
}
