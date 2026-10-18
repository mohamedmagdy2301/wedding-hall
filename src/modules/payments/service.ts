import { and, eq } from "drizzle-orm";
import { bookings as bookingsTable, payments } from "@/db/schema";
import { depositViolation } from "@/domain/deposit";
import { rebalanceSchedule, scheduleViolation, type ScheduleLine } from "@/domain/installments";
import { activeDeposit, exceedsTotal, netPaid, type PaymentKind } from "@/domain/payments";
import { addYears, cairoDate, cairoInstant, cairoTimeOfDay } from "@/lib/time";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { readVenuePolicies } from "@/modules/settings/venue";
import type { ServiceDeps } from "@/modules/shared/context";
import type { Tx } from "@/modules/shared/db";
import { AppError, forbidden, notFound } from "@/modules/shared/errors";
import { runTransaction } from "@/modules/shared/transaction";
import { assertAllowed, satisfies } from "@/modules/users-rbac/authorize";
import {
  activeMethodName,
  assertTakesPayments,
  insertPayment,
  lockBookingForPayment,
  readLedgerRows,
  readSchedule,
  replaceSchedule,
} from "./repository";
import type { RecordDepositInput, RecordPaymentInput, SetInstallmentsInput, VoidPaymentInput } from "./schemas";

/**
 * Payments, the replacement deposit, voiding and the schedule (BR-60..66, D-118..D-126).
 * Each operation is one transaction with its audit rows (CLAUDE.md rule 7), locks the
 * booking first (D-126) and takes the receipt number last (D-125).
 */

const stamp = (instant: Date) => `${cairoDate(instant)} ${cairoTimeOfDay(instant)}`;

/**
 * D-118: the payment date. Without one it is now (the server's clock). A date — even today —
 * needs `payments.backdate`; it is a Cairo day from three years ago to today, stored at noon
 * Cairo time when it is in the past.
 */
export function resolvePaidAt(actor: SessionUser, paidAt: string | null, now: Date) {
  if (paidAt === null) return { paidAt: now, backdated: false };
  if (!satisfies(actor, "payments.backdate")) throw forbidden("backdateForbidden", "D-118");
  const today = cairoDate(now);
  if (paidAt > today)
    throw new AppError("VALIDATION_ERROR", "paidAtFuture", { fieldErrors: { paidAt: "paidAtFuture" } });
  if (paidAt < addYears(today, -3)) {
    throw new AppError("VALIDATION_ERROR", "paidAtTooOld", { fieldErrors: { paidAt: "paidAtTooOld" } });
  }
  if (paidAt === today) return { paidAt: now, backdated: false };
  return { paidAt: cairoInstant(paidAt, "12:00"), backdated: true };
}

/** BR-65 as an API error, keyed to the line at fault. */
export function assertSchedule(input: { total: number; deposit: number; eventDate: string; lines: ScheduleLine[] }) {
  const found = scheduleViolation(input);
  if (!found) return;
  const field =
    found.violation === "installmentAmountInvalid"
      ? `installments.${found.index}.amount`
      : found.violation === "installmentAfterEve"
        ? `installments.${found.index}.dueDate`
        : "installments";
  throw new AppError("BUSINESS_RULE_VIOLATION", found.violation, {
    rule: "BR-65",
    fieldErrors: { [field]: found.violation },
    details: found.violation === "scheduleSumMismatch" ? { difference: found.difference } : undefined,
  });
}

/** The audit row of a recorded payment, found again from its booking's history (D-108). */
export async function auditPayment(
  tx: Tx,
  actor: SessionUser,
  payment: {
    id: string;
    receiptNo: string;
    bookingId: string;
    bookingNo: string;
    kind: PaymentKind;
    amount: number;
    paidAt: Date;
    method: string;
    note: string | null;
    backdated: boolean;
  },
) {
  await recordAudit(tx, {
    venueId: actor.venueId,
    actorId: actor.userId,
    action: "payments.record",
    entityType: "payment",
    entityId: payment.id,
    after: {
      bookingNo: payment.bookingNo,
      receiptNo: payment.receiptNo,
      kind: payment.kind,
      amount: payment.amount,
      method: payment.method,
      paidAt: stamp(payment.paidAt),
      note: payment.note,
    },
    meta: { bookingId: payment.bookingId, ...(payment.backdated ? { backdated: true } : {}) },
  });
}

async function auditSchedule(
  tx: Tx,
  actor: SessionUser,
  booking: { id: string; bookingNo: string },
  before: ScheduleLine[],
  after: ScheduleLine[],
  reason: "set" | "rebalanced",
) {
  await recordAudit(tx, {
    venueId: actor.venueId,
    actorId: actor.userId,
    action: "installments.set",
    entityType: "booking",
    entityId: booking.id,
    before: { installments: before },
    after: { installments: after },
    meta: { bookingNo: booking.bookingNo, ...(reason === "rebalanced" ? { rebalanced: true } : {}) },
  });
}

/** `payments.record` (BR-61..63): a collection on a confirmed booking; the server picks its kind (D-126). */
export async function recordPayment(deps: ServiceDeps, actor: SessionUser, input: RecordPaymentInput) {
  assertAllowed(actor, "payments.record");
  const when = resolvePaidAt(actor, input.paidAt, deps.now);
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const booking = await lockBookingForPayment(tx, venueId, input.bookingId);
    assertTakesPayments(booking.status);
    const method = await activeMethodName(tx, venueId, input.methodId);
    const total = booking.total ?? 0;
    const [rows, schedule] = await Promise.all([readLedgerRows(tx, booking.id), readSchedule(tx, booking.id)]);
    const paid = netPaid(rows);
    if (exceedsTotal(total, paid, input.amount)) {
      throw new AppError("BUSINESS_RULE_VIOLATION", "overpayment", {
        rule: "BR-63",
        fieldErrors: { amount: "overpayment" },
        details: { remaining: total - paid },
      });
    }
    const kind: PaymentKind = schedule.length > 0 ? "installment" : "payment";
    const payment = await insertPayment(tx, {
      venueId,
      bookingId: booking.id,
      kind,
      amount: input.amount,
      methodId: input.methodId,
      paidAt: when.paidAt,
      receivedBy: actor.userId,
      note: input.note,
    });
    await auditPayment(tx, actor, {
      ...payment,
      bookingId: booking.id,
      bookingNo: booking.bookingNo,
      kind,
      amount: input.amount,
      paidAt: when.paidAt,
      method,
      note: input.note,
      backdated: when.backdated,
    });
    return { paymentId: payment.id, receiptNo: payment.receiptNo, kind };
  });
}

/**
 * `payments.recordDeposit` (BR-60, D-40, D-121): a new deposit once the previous one was
 * voided, at least the current minimum (D-119) and within the remaining amount (BR-63). A
 * schedule on the booking must still add up: rebalanced when none is sent, checked as sent
 * otherwise.
 */
export async function recordDeposit(deps: ServiceDeps, actor: SessionUser, input: RecordDepositInput) {
  assertAllowed(actor, "payments.record");
  const when = resolvePaidAt(actor, input.paidAt, deps.now);
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const booking = await lockBookingForPayment(tx, venueId, input.bookingId);
    assertTakesPayments(booking.status);
    const method = await activeMethodName(tx, venueId, input.methodId);
    const total = booking.total ?? 0;
    const [rows, schedule, policies] = await Promise.all([
      readLedgerRows(tx, booking.id),
      readSchedule(tx, booking.id),
      readVenuePolicies(tx, venueId),
    ]);
    if (activeDeposit(rows)) throw new AppError("BUSINESS_RULE_VIOLATION", "depositExists", { rule: "BR-60" });
    const key =
      depositViolation(total, policies, input.amount) ??
      (exceedsTotal(total, netPaid(rows), input.amount) ? "overpayment" : null);
    if (key) {
      throw new AppError("BUSINESS_RULE_VIOLATION", key, {
        rule: key === "depositBelowMinimum" ? "BR-21" : "BR-63",
        fieldErrors: { amount: key },
      });
    }

    const eventDate = cairoDate(booking.startsAt);
    let newSchedule: ScheduleLine[] | null = null;
    if (input.installments !== undefined) {
      assertSchedule({ total, deposit: input.amount, eventDate, lines: input.installments });
      newSchedule = input.installments;
    } else if (schedule.length > 0) {
      const rebalanced = rebalanceSchedule(schedule, total - input.amount);
      if (!rebalanced) {
        throw new AppError("BUSINESS_RULE_VIOLATION", "scheduleNeedsEdit", {
          rule: "D-121",
          fieldErrors: { installments: "scheduleNeedsEdit" },
        });
      }
      newSchedule = rebalanced;
    }

    const payment = await insertPayment(tx, {
      venueId,
      bookingId: booking.id,
      kind: "deposit",
      amount: input.amount,
      methodId: input.methodId,
      paidAt: when.paidAt,
      receivedBy: actor.userId,
      note: input.note,
    });
    await auditPayment(tx, actor, {
      ...payment,
      bookingId: booking.id,
      bookingNo: booking.bookingNo,
      kind: "deposit",
      amount: input.amount,
      paidAt: when.paidAt,
      method,
      note: input.note,
      backdated: when.backdated,
    });
    if (newSchedule && JSON.stringify(newSchedule) !== JSON.stringify(schedule)) {
      await replaceSchedule(tx, venueId, booking.id, newSchedule);
      await auditSchedule(tx, actor, booking, schedule, newSchedule, input.installments ? "set" : "rebalanced");
    }
    return { paymentId: payment.id, receiptNo: payment.receiptNo, installments: newSchedule ?? schedule };
  });
}

/** `payments.void` (BR-64): once, with a reason; the number stays taken. Voiding the deposit keeps the booking confirmed (D-40). */
export async function voidPayment(deps: ServiceDeps, actor: SessionUser, input: VoidPaymentInput) {
  assertAllowed(actor, "payments.void");
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const [found] = await tx
      .select({ bookingId: payments.bookingId })
      .from(payments)
      .where(and(eq(payments.id, input.paymentId), eq(payments.venueId, venueId)));
    if (!found) throw notFound("paymentNotFound");
    // The booking first, like every payment operation (D-126).
    const booking = await lockBookingForPayment(tx, venueId, found.bookingId);
    const [payment] = await tx
      .select({
        receiptNo: payments.receiptNo,
        kind: payments.kind,
        amount: payments.amount,
        voidedAt: payments.voidedAt,
      })
      .from(payments)
      .where(eq(payments.id, input.paymentId))
      .for("update");
    if (payment.voidedAt) throw new AppError("BUSINESS_RULE_VIOLATION", "paymentAlreadyVoided", { rule: "BR-64" });
    await tx
      .update(payments)
      .set({ voidedAt: deps.now, voidedBy: actor.userId, voidReason: input.reason })
      .where(eq(payments.id, input.paymentId));
    await recordAudit(tx, {
      venueId,
      actorId: actor.userId,
      action: "payments.void",
      entityType: "payment",
      entityId: input.paymentId,
      before: {
        bookingNo: booking.bookingNo,
        receiptNo: payment.receiptNo,
        kind: payment.kind,
        amount: payment.amount,
      },
      after: { voidReason: input.reason },
      meta: { bookingId: booking.id },
    });
    return { depositVoided: payment.kind === "deposit" };
  });
}

/** `installments.set` (BR-65, D-126): replaces the whole schedule of a confirmed booking; empty removes it. */
export async function setInstallments(deps: ServiceDeps, actor: SessionUser, input: SetInstallmentsInput) {
  assertAllowed(actor, "payments.record");
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const booking = await lockBookingForPayment(tx, venueId, input.bookingId);
    if (booking.version !== input.version) throw new AppError("CONCURRENT_MODIFICATION", "bookingChanged");
    assertTakesPayments(booking.status);
    const [rows, before] = await Promise.all([readLedgerRows(tx, booking.id), readSchedule(tx, booking.id)]);
    const deposit = activeDeposit(rows);
    if (!deposit && input.installments.length > 0) {
      throw new AppError("BUSINESS_RULE_VIOLATION", "depositMissingForSchedule", { rule: "D-40" });
    }
    assertSchedule({
      total: booking.total ?? 0,
      deposit: deposit?.amount ?? 0,
      eventDate: cairoDate(booking.startsAt),
      lines: input.installments,
    });
    await replaceSchedule(tx, venueId, booking.id, input.installments);
    const [row] = await tx
      .update(bookingsTable)
      .set({ version: booking.version + 1 })
      .where(eq(bookingsTable.id, booking.id))
      .returning({ version: bookingsTable.version });
    await auditSchedule(tx, actor, booking, before, input.installments, "set");
    return { version: row.version };
  });
}
