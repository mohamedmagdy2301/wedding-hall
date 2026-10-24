import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { bookings, customers, installments, paymentMethods, payments, spaces, users, venues } from "@/db/schema";
import { installmentStatuses } from "@/domain/installments";
import { activeDeposit, ledger, netPaid, paidAsOfReceipt } from "@/domain/payments";
import { addDays, cairoDate } from "@/lib/time";
import type { SessionUser } from "@/modules/auth/sessions";
import type { DbOrTx } from "@/modules/shared/db";
import { notFound } from "@/modules/shared/errors";
import { readVenuePolicies } from "@/modules/settings/venue";
import { assertAllowed, satisfies } from "@/modules/users-rbac/authorize";
import { totalAsOf } from "@/modules/bookings/changes";
import { readLedgerRows, readSchedule } from "./repository";
import type { CollectionsFilters } from "./schemas";

/** Reads for the payments tab (S-07), the receipts (P-03, P-04) and collections (S-09). Paid is never stored (BR-62). */

/**
 * Net paid of the booking row in the enclosing query (BR-62), for lists. Qualified by hand,
 * like `overlapsConfirmedSql`: the outer table is `bookings` without an alias.
 */
export const netPaidSql = sql<number>`coalesce((SELECT sum(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END)
  FROM payments p WHERE p.booking_id = "bookings"."id" AND p.voided_at IS NULL), 0)::bigint`.mapWith(Number);

const voider = alias(users, "voider");

/** The payments tab (`bookings.view`): ledger, movements with their receipts, schedule with each line's state. */
export async function bookingPayments(
  db: DbOrTx,
  venueId: string,
  booking: { id: string; total: number | null; status: "tentative" | "confirmed" | "cancelled" },
  now: Date,
) {
  const [rows, schedule] = await Promise.all([
    db
      .select({
        id: payments.id,
        receiptNo: payments.receiptNo,
        kind: payments.kind,
        amount: payments.amount,
        paidAt: payments.paidAt,
        createdAt: payments.createdAt,
        note: payments.note,
        methodName: paymentMethods.name,
        receivedByName: users.name,
        voidedAt: payments.voidedAt,
        voidReason: payments.voidReason,
        voidedByName: voider.name,
      })
      .from(payments)
      .innerJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
      .innerJoin(users, eq(users.id, payments.receivedBy))
      .leftJoin(voider, eq(voider.id, payments.voidedBy))
      .where(and(eq(payments.bookingId, booking.id), eq(payments.venueId, venueId)))
      .orderBy(sql`length(${payments.receiptNo})`, asc(payments.receiptNo)),
    readSchedule(db, booking.id),
  ]);
  const entries = rows.map((r) => ({ ...r, voided: r.voidedAt !== null }));
  const total = booking.total ?? 0;
  const money = ledger(total, entries);
  const deposit = activeDeposit(entries);
  return {
    ledger: money,
    payments: rows,
    installments: installmentStatuses(total, schedule, money.paid, cairoDate(now)),
    activeDeposit: deposit ? { id: deposit.id, amount: deposit.amount } : null,
    // D-40: confirmed, its deposit voided and no replacement yet.
    depositMissing: booking.status === "confirmed" && !deposit,
  };
}

/** P-03 / P-04 (`bookings.view`): a receipt with paid and remaining as of its issuance (D-122). */
export async function getReceipt(db: DbOrTx, actor: SessionUser, paymentId: string) {
  assertAllowed(actor, "bookings.view");
  const [row] = await db
    .select({
      id: payments.id,
      bookingId: payments.bookingId,
      receiptNo: payments.receiptNo,
      kind: payments.kind,
      amount: payments.amount,
      paidAt: payments.paidAt,
      createdAt: payments.createdAt,
      note: payments.note,
      voidedAt: payments.voidedAt,
      voidReason: payments.voidReason,
      methodName: paymentMethods.name,
      receivedByName: users.name,
      bookingNo: bookings.bookingNo,
      total: bookings.total,
      startsAt: bookings.startsAt,
      spaceName: spaces.name,
      customerName: customers.name,
      customerPhone: customers.phone,
      venueName: venues.name,
      venuePhone: venues.phone,
      venueAddress: venues.address,
    })
    .from(payments)
    .innerJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
    .innerJoin(users, eq(users.id, payments.receivedBy))
    .innerJoin(bookings, eq(bookings.id, payments.bookingId))
    .innerJoin(spaces, eq(spaces.id, bookings.spaceId))
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .innerJoin(venues, eq(venues.id, payments.venueId))
    .where(and(eq(payments.id, paymentId), eq(payments.venueId, actor.venueId)));
  if (!row) throw notFound("paymentNotFound");
  const paid = paidAsOfReceipt(await readLedgerRows(db, row.bookingId), row.receiptNo);
  // D-122: the total as of the receipt too, not the one after later changes.
  const total = await totalAsOf(db, row.id, row.bookingId, row.total ?? 0);
  return { ...row, eventDate: cairoDate(row.startsAt), total, paid, remaining: total - paid };
}

export type Receipt = Awaited<ReturnType<typeof getReceipt>>;

/**
 * S-09 (`payments.record`, D-123, D-127): installments not covered yet of confirmed bookings,
 * due in [from, to] — by default everything overdue and what falls due in the next 7 days.
 * Coverage is per booking, oldest first (D-120).
 */
export async function listCollections(db: DbOrTx, actor: SessionUser, filters: CollectionsFilters, now: Date) {
  assertAllowed(actor, "payments.record");
  const today = cairoDate(now);
  const to = filters.to || addDays(today, 7);
  const from = filters.from || null;
  const lines = await db
    .select({
      bookingId: installments.bookingId,
      dueDate: installments.dueDate,
      amount: installments.amount,
      bookingNo: bookings.bookingNo,
      total: bookings.total,
      startsAt: bookings.startsAt,
      customerName: customers.name,
      customerPhone: customers.phone,
      spaceName: spaces.name,
    })
    .from(installments)
    .innerJoin(bookings, eq(bookings.id, installments.bookingId))
    .innerJoin(customers, eq(customers.id, bookings.customerId))
    .innerJoin(spaces, eq(spaces.id, bookings.spaceId))
    .where(and(eq(installments.venueId, actor.venueId), eq(bookings.status, "confirmed")))
    .orderBy(asc(installments.dueDate), asc(installments.sortOrder));
  const bookingIds = [...new Set(lines.map((l) => l.bookingId))];
  const paidRows =
    bookingIds.length === 0
      ? []
      : await db
          .select({ bookingId: payments.bookingId, kind: payments.kind, amount: payments.amount })
          .from(payments)
          .where(and(inArray(payments.bookingId, bookingIds), isNull(payments.voidedAt)));

  const rows = bookingIds.flatMap((bookingId) => {
    const own = lines.filter((l) => l.bookingId === bookingId);
    const head = own[0];
    const total = head.total ?? 0;
    const paid = netPaid(paidRows.filter((p) => p.bookingId === bookingId).map((p) => ({ ...p, voided: false })));
    return installmentStatuses(total, own, paid, today)
      .filter((s) => s.outstanding > 0 && s.dueDate <= to && (from === null || s.dueDate >= from))
      .map((s) => ({
        bookingId,
        bookingNo: head.bookingNo,
        customerName: head.customerName,
        customerPhone: head.customerPhone,
        spaceName: head.spaceName,
        eventDate: cairoDate(head.startsAt),
        dueDate: s.dueDate,
        amount: s.amount,
        outstanding: s.outstanding,
        state: s.state,
        remaining: total - paid,
      }));
  });
  rows.sort((a, b) =>
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.bookingNo.localeCompare(b.bookingNo),
  );
  return { rows, from, to, today };
}

/**
 * What the deposit and payment forms choose from (`payments.record`): the active methods, the
 * minimum-deposit policy for the hint (D-119; the server decides) and whether the actor may
 * date a payment in the past (D-118).
 */
export async function getPaymentFormOptions(db: DbOrTx, actor: SessionUser) {
  assertAllowed(actor, "payments.record");
  const [methods, policies] = await Promise.all([
    db
      .select({ id: paymentMethods.id, name: paymentMethods.name })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.venueId, actor.venueId), eq(paymentMethods.isActive, true)))
      .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name)),
    readVenuePolicies(db, actor.venueId),
  ]);
  return {
    methods,
    minDeposit: { minDepositType: policies.minDepositType, minDepositValue: policies.minDepositValue },
    canBackdate: satisfies(actor, "payments.backdate"),
  };
}

export type PaymentFormOptions = Awaited<ReturnType<typeof getPaymentFormOptions>>;

/** The venue's active payment methods, for refunding a credit (BR-83) from screens of other permissions. */
export async function activePaymentMethods(db: DbOrTx, venueId: string) {
  return db
    .select({ id: paymentMethods.id, name: paymentMethods.name })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.venueId, venueId), eq(paymentMethods.isActive, true)))
    .orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name));
}
