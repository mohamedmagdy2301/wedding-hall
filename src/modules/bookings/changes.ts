import { and, asc, eq, gt, sql } from "drizzle-orm";
import { bookingChanges, discountRequests, payments } from "@/db/schema";
import { rebalanceSchedule, type ScheduleLine } from "@/domain/installments";
import { activeDeposit, netPaid } from "@/domain/payments";
import { cairoDate } from "@/lib/time";
import type { SessionUser } from "@/modules/auth/sessions";
import {
  activeMethodName,
  insertPayment,
  readLedgerRows,
  readSchedule,
  replaceSchedule,
} from "@/modules/payments/repository";
import { assertSchedule, auditPayment, auditSchedule } from "@/modules/payments/service";
import { readVenuePolicies } from "@/modules/settings/venue";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { AppError, forbidden } from "@/modules/shared/errors";
import { satisfies } from "@/modules/users-rbac/authorize";

/**
 * What every change of a confirmed booking's total does in its own transaction (BR-42,
 * BR-65, BR-83, D-36, D-130): the schedule adjusted, a credit for the customer settled the
 * way the venue's policy allows, and a `booking_changes` row with before and after — the
 * history receipts read their total from (D-122).
 */

export type CreditChoice = { resolution: "refund" | "services"; methodId: string | null };

/** Σ approved discounts of a booking (BR-50): the source of `discount_amount`. */
export async function approvedDiscount(db: DbOrTx, bookingId: string): Promise<number> {
  const [row] = await db
    .select({ sum: sql<number>`coalesce(sum(${discountRequests.amount}), 0)::bigint`.mapWith(Number) })
    .from(discountRequests)
    .where(and(eq(discountRequests.bookingId, bookingId), eq(discountRequests.status, "approved")));
  return row.sum;
}

/**
 * The credit a lower total leaves (paid − total), and how it would be settled (D-36): the
 * venue's mode, or the staff member's choice when it is `both`. Read-only, for previews.
 */
export async function creditOutlook(db: DbOrTx, venueId: string, bookingId: string, totalAfter: number) {
  const [rows, settings] = await Promise.all([readLedgerRows(db, bookingId), readVenuePolicyMode(db, venueId)]);
  const paid = netPaid(rows);
  return { paid, credit: Math.max(0, paid - totalAfter), mode: settings };
}

async function readVenuePolicyMode(db: DbOrTx, venueId: string) {
  const { postponeCreditMode } = await readVenuePolicies(db, venueId);
  return postponeCreditMode;
}

export type TotalChange = {
  /** Set when lines were written for this change before its row (deferred keys, D-130). */
  changeId?: string;
  booking: { id: string; bookingNo: string; startsAt: Date };
  kind: "items" | "guests" | "price_override" | "discount" | "postpone";
  before: unknown;
  after: unknown;
  totalBefore: number;
  totalAfter: number;
  /** A schedule as sent (checked as is); otherwise an existing one is rebalanced (D-34, D-121). */
  installments?: ScheduleLine[];
  credit?: CreditChoice | null;
};

/**
 * Applies the consequences of a new total, after the booking row was locked and updated.
 * Order: the change row, the schedule, then the refund — its receipt number last (D-125).
 */
export async function recordTotalChange(tx: Tx, actor: SessionUser, now: Date, change: TotalChange) {
  const venueId = actor.venueId;
  const { booking, totalAfter } = change;
  const [rows, schedule, mode] = await Promise.all([
    readLedgerRows(tx, booking.id),
    readSchedule(tx, booking.id),
    readVenuePolicyMode(tx, venueId),
  ]);
  const paid = netPaid(rows);

  // BR-83, D-36: a credit made by this change (a lower total below what was paid).
  const credit = totalAfter < change.totalBefore ? Math.max(0, paid - totalAfter) : 0;
  let resolution: CreditChoice["resolution"] | null = null;
  let methodName: string | null = null;
  if (credit > 0) {
    resolution = mode === "both" ? (change.credit?.resolution ?? null) : mode;
    if (!resolution) {
      throw new AppError("BUSINESS_RULE_VIOLATION", "creditResolutionRequired", {
        rule: "BR-83",
        fieldErrors: { "credit.resolution": "creditResolutionRequired" },
        details: { credit, mode },
      });
    }
    if (resolution === "refund") {
      if (!satisfies(actor, "payments.refund")) throw forbidden("refundForbidden", "BR-83");
      const methodId = change.credit?.methodId;
      if (!methodId) {
        throw new AppError("VALIDATION_ERROR", "refundMethodRequired", {
          fieldErrors: { "credit.methodId": "refundMethodRequired" },
          details: { credit, mode },
        });
      }
      methodName = await activeMethodName(tx, venueId, methodId);
    }
  }

  const [row] = await tx
    .insert(bookingChanges)
    .values({
      ...(change.changeId ? { id: change.changeId } : {}),
      venueId,
      bookingId: booking.id,
      kind: change.kind,
      before: change.before ?? {},
      after: change.after ?? {},
      totalBefore: change.totalBefore,
      totalAfter,
      creditResolution: resolution,
      createdBy: actor.userId,
    })
    .returning({ id: bookingChanges.id });

  // BR-65: the schedule still adds up to the new total.
  const deposit = activeDeposit(rows)?.amount ?? 0;
  let newSchedule: ScheduleLine[] | null = null;
  if (change.installments !== undefined) {
    assertSchedule({ total: totalAfter, deposit, eventDate: cairoDate(booking.startsAt), lines: change.installments });
    newSchedule = change.installments;
  } else if (schedule.length > 0 && totalAfter !== change.totalBefore) {
    newSchedule = rebalanceSchedule(schedule, Math.max(0, totalAfter - deposit)) ?? [];
  }
  if (newSchedule && JSON.stringify(newSchedule) !== JSON.stringify(schedule)) {
    await replaceSchedule(tx, venueId, booking.id, newSchedule);
    await auditSchedule(tx, actor, booking, schedule, newSchedule, change.installments ? "set" : "rebalanced");
  }

  let refund: { paymentId: string; receiptNo: string; amount: number } | null = null;
  if (resolution === "refund") {
    const payment = await insertPayment(tx, {
      venueId,
      bookingId: booking.id,
      kind: "refund",
      amount: credit,
      methodId: change.credit!.methodId!,
      paidAt: now,
      receivedBy: actor.userId,
      note: null,
    });
    await auditPayment(tx, actor, {
      ...payment,
      bookingId: booking.id,
      bookingNo: booking.bookingNo,
      kind: "refund",
      amount: credit,
      paidAt: now,
      method: methodName!,
      note: null,
      backdated: false,
    });
    refund = { paymentId: payment.id, receiptNo: payment.receiptNo, amount: credit };
  }

  return {
    changeId: row.id,
    credit,
    creditResolution: resolution,
    refund,
    installments: newSchedule ?? schedule,
  };
}

/**
 * D-122: the total a receipt was issued against — the total before the first change made
 * after it, or the current one. A refund issued by a change is after it (same instant).
 * Compared in SQL: a JavaScript Date drops the microseconds of `created_at`.
 */
export async function totalAsOf(db: DbOrTx, paymentId: string, bookingId: string, current: number): Promise<number> {
  const [next] = await db
    .select({ totalBefore: bookingChanges.totalBefore })
    .from(bookingChanges)
    .where(
      and(
        eq(bookingChanges.bookingId, bookingId),
        gt(
          bookingChanges.createdAt,
          sql`(SELECT ${payments.createdAt} FROM ${payments} WHERE ${payments.id} = ${paymentId})`,
        ),
      ),
    )
    .orderBy(asc(bookingChanges.createdAt), asc(bookingChanges.id))
    .limit(1);
  return next ? next.totalBefore : current;
}
