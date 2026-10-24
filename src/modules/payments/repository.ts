import { and, asc, eq, sql } from "drizzle-orm";
import { bookings, installments, paymentMethods, payments, receiptCounters } from "@/db/schema";
import type { ScheduleLine } from "@/domain/installments";
import { formatReceiptNo, type PaymentKind } from "@/domain/payments";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { AppError, notFound } from "@/modules/shared/errors";

/** Payment rows shared by the payment services and the confirmation (D-125, D-126). */

/**
 * The venue's next receipt number (BR-61, D-125). The upsert locks the counter row until the
 * transaction ends: no duplicates under concurrency, and a failed or retried operation gives
 * its number back, so numbers have no gaps. Take it last in the transaction: it queues every
 * payment of the venue.
 */
export async function nextReceiptNumber(tx: Tx, venueId: string): Promise<string> {
  const [row] = await tx
    .insert(receiptCounters)
    .values({ venueId, lastNo: 1 })
    .onConflictDoUpdate({
      target: receiptCounters.venueId,
      set: { lastNo: sql`${receiptCounters.lastNo} + 1`, updatedAt: sql`now()` },
    })
    .returning({ lastNo: receiptCounters.lastNo });
  return formatReceiptNo(row.lastNo);
}

/** The booking row locked for a payment (D-126): BR-63 is checked against a total and a ledger nobody else changes meanwhile. */
export async function lockBookingForPayment(tx: Tx, venueId: string, bookingId: string) {
  const [row] = await tx
    .select({
      id: bookings.id,
      bookingNo: bookings.bookingNo,
      status: bookings.status,
      total: bookings.total,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      version: bookings.version,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, venueId)))
    .for("update");
  if (!row) throw notFound("bookingNotFound");
  return row;
}

/** BR-25 and D-126: payments go on confirmed bookings only, completed ones included (BR-24). */
export function assertTakesPayments(status: "tentative" | "confirmed" | "cancelled") {
  if (status === "tentative") throw new AppError("BUSINESS_RULE_VIOLATION", "paymentsOnTentative", { rule: "BR-25" });
  if (status === "cancelled") throw new AppError("BUSINESS_RULE_VIOLATION", "paymentsOnCancelled");
}

/** A payment method of the venue that is active; its name for the audit row. */
export async function activeMethodName(db: DbOrTx, venueId: string, methodId: string): Promise<string> {
  const [row] = await db
    .select({ name: paymentMethods.name, isActive: paymentMethods.isActive })
    .from(paymentMethods)
    .where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.venueId, venueId)));
  if (!row)
    throw new AppError("NOT_FOUND", "paymentMethodNotFound", { fieldErrors: { methodId: "paymentMethodNotFound" } });
  if (!row.isActive) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "paymentMethodInactive", {
      fieldErrors: { methodId: "paymentMethodInactive" },
    });
  }
  return row.name;
}

export async function readLedgerRows(db: DbOrTx, bookingId: string) {
  const rows = await db
    .select({
      id: payments.id,
      receiptNo: payments.receiptNo,
      kind: payments.kind,
      amount: payments.amount,
      voidedAt: payments.voidedAt,
      createdAt: payments.createdAt,
    })
    .from(payments)
    .where(eq(payments.bookingId, bookingId))
    .orderBy(sql`length(${payments.receiptNo})`, asc(payments.receiptNo));
  return rows.map((r) => ({ ...r, voided: r.voidedAt !== null }));
}

export async function readSchedule(db: DbOrTx, bookingId: string): Promise<ScheduleLine[]> {
  return db
    .select({ dueDate: installments.dueDate, amount: installments.amount })
    .from(installments)
    .where(eq(installments.bookingId, bookingId))
    .orderBy(asc(installments.dueDate), asc(installments.sortOrder));
}

/** Replaces the schedule (D-126): it is not a financial record; the audit row keeps before and after. */
export async function replaceSchedule(tx: Tx, venueId: string, bookingId: string, lines: readonly ScheduleLine[]) {
  await tx.delete(installments).where(eq(installments.bookingId, bookingId));
  if (lines.length === 0) return;
  await tx.insert(installments).values(
    lines.map((line, index) => ({
      venueId,
      bookingId,
      dueDate: line.dueDate,
      amount: line.amount,
      sortOrder: index,
    })),
  );
}

export async function insertPayment(
  tx: Tx,
  row: {
    venueId: string;
    bookingId: string;
    kind: PaymentKind;
    amount: number;
    methodId: string;
    paidAt: Date;
    receivedBy: string;
    note: string | null;
  },
): Promise<{ id: string; receiptNo: string }> {
  const receiptNo = await nextReceiptNumber(tx, row.venueId);
  const [inserted] = await tx
    .insert(payments)
    .values({
      venueId: row.venueId,
      bookingId: row.bookingId,
      receiptNo,
      kind: row.kind,
      amount: row.amount,
      paymentMethodId: row.methodId,
      paidAt: row.paidAt,
      receivedBy: row.receivedBy,
      note: row.note,
    })
    .returning({ id: payments.id });
  return { id: inserted.id, receiptNo };
}
