import { and, eq } from "drizzle-orm";
import { bookings, discountRequests } from "@/db/schema";
import { cancellationQuote } from "@/domain/cancellation";
import type { CancellationTier } from "@/domain/cancellation-tiers";
import { cairoDate } from "@/lib/time";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { activeMethodName, insertPayment, readLedgerRows } from "@/modules/payments/repository";
import { auditPayment } from "@/modules/payments/service";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { AppError, forbidden, notFound } from "@/modules/shared/errors";
import { runTransaction } from "@/modules/shared/transaction";
import { satisfies } from "@/modules/users-rbac/authorize";
import type { CancelInput } from "./schemas";
import { readBookingSnapshot } from "./service";

/**
 * `bookings.cancelPreview` and `bookings.cancel` (BR-70..76, UF-09, Q8-01..05). A confirmed
 * booking is cancelled by the tiers and basis fixed with it at confirmation (D-68), on the
 * Cairo date of the click (Q8-04); the refund, the status and the audit go in one
 * transaction (BR-74) and the slot is free at once (the constraint covers confirmed rows
 * only). A tentative one has no money to settle (BR-25, BR-75). Cancelled is final (Q8-03).
 */

type CancelBookingRow = {
  id: string;
  bookingNo: string;
  status: "tentative" | "confirmed" | "cancelled";
  version: number;
  startsAt: Date;
  endsAt: Date;
  cancellationBasis: "deposit" | "total_paid" | null;
  cancellationTiers: unknown;
};

async function readCancelBooking(db: DbOrTx, venueId: string, bookingId: string, lock: boolean) {
  const query = db
    .select({
      id: bookings.id,
      bookingNo: bookings.bookingNo,
      status: bookings.status,
      version: bookings.version,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      cancellationBasis: bookings.cancellationBasis,
      cancellationTiers: bookings.cancellationTiers,
    })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, venueId)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("bookingNotFound");
  return row as CancelBookingRow;
}

/** Neither permission: refused before the booking is even read. */
function assertMayCancelAny(actor: SessionUser) {
  if (!satisfies(actor, "bookings.cancel") && !satisfies(actor, "bookings.edit")) throw forbidden();
}

/** Q8-05: a tentative booking by `bookings.edit` or `bookings.cancel`, a confirmed one by `bookings.cancel`. */
function assertMayCancel(actor: SessionUser, booking: CancelBookingRow, now: Date) {
  if (booking.status === "cancelled")
    throw new AppError("BUSINESS_RULE_VIOLATION", "bookingCancelled", { rule: "BR-76" });
  const allowed =
    satisfies(actor, "bookings.cancel") || (booking.status === "tentative" && satisfies(actor, "bookings.edit"));
  if (!allowed) throw forbidden();
  // BR-76 (D-54): not once a confirmed party is over.
  if (booking.status === "confirmed" && booking.endsAt <= now) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "bookingCompleted", { rule: "BR-76" });
  }
}

/** The snapshot's tiers as stored (D-68): `[{min_days_before, refund_bps}]`. */
/** The tiers stored with the booking at confirmation (D-68), as the domain reads them. */
export const snapshotTiers = (stored: unknown): CancellationTier[] =>
  ((stored ?? []) as { min_days_before: number; refund_bps: number }[]).map((t) => ({
    minDaysBefore: t.min_days_before,
    refundBps: t.refund_bps,
  }));

async function quoteFor(db: DbOrTx, booking: CancelBookingRow, now: Date) {
  const rows = await readLedgerRows(db, booking.id);
  return cancellationQuote({
    tiers: snapshotTiers(booking.cancellationTiers),
    basis: booking.cancellationBasis ?? "deposit",
    ledger: rows,
    eventDate: cairoDate(booking.startsAt),
    cancelDate: cairoDate(now),
  });
}

/** `bookings.cancelPreview` (read-only): the days, the tier, the basis and the suggested refund. */
export async function cancelPreview(db: DbOrTx, actor: SessionUser, bookingId: string, now: Date) {
  assertMayCancelAny(actor);
  const booking = await readCancelBooking(db, actor.venueId, bookingId, false);
  assertMayCancel(actor, booking, now);
  if (booking.status === "tentative") return { status: "tentative" as const, version: booking.version };
  const quote = await quoteFor(db, booking, now);
  return {
    status: "confirmed" as const,
    version: booking.version,
    basisKind: booking.cancellationBasis!,
    tiers: snapshotTiers(booking.cancellationTiers),
    ...quote,
  };
}

export type CancelPreview = Awaited<ReturnType<typeof cancelPreview>>;

/** Pending discount requests are withdrawn with the booking (Q8-03), each with its audit row. */
async function withdrawPending(tx: Tx, actor: SessionUser, now: Date, booking: CancelBookingRow) {
  const pending = await tx
    .update(discountRequests)
    .set({ status: "withdrawn", decidedBy: actor.userId, decidedAt: now })
    .where(and(eq(discountRequests.bookingId, booking.id), eq(discountRequests.status, "pending")))
    .returning({ id: discountRequests.id, amount: discountRequests.amount });
  for (const request of pending) {
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "discounts.withdraw",
      entityType: "discount_request",
      entityId: request.id,
      before: { bookingNo: booking.bookingNo, amount: request.amount, status: "pending" },
      after: { status: "withdrawn" },
      meta: { bookingId: booking.id, byCancellation: true },
    });
  }
}

/** `bookings.cancel` (+ `payments.refund` when something is paid back). */
export async function cancelBooking(deps: ServiceDeps, actor: SessionUser, input: CancelInput) {
  assertMayCancelAny(actor);
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const booking = await readCancelBooking(tx, venueId, input.bookingId, true);
    assertMayCancel(actor, booking, deps.now);
    if (booking.version !== input.version) throw new AppError("CONCURRENT_MODIFICATION", "bookingChanged");

    let refund: { paymentId: string; receiptNo: string; amount: number } | null = null;
    let quote: Awaited<ReturnType<typeof quoteFor>> | null = null;
    if (booking.status === "tentative") {
      if (input.refundAmount > 0) {
        throw new AppError("BUSINESS_RULE_VIOLATION", "refundOnTentative", {
          rule: "BR-75",
          fieldErrors: { refundAmount: "refundOnTentative" },
        });
      }
    } else {
      quote = await quoteFor(tx, booking, deps.now);
      const amount = input.refundAmount;
      // BR-73 (Q8-02): up or down from the suggestion, never above the net paid, with a reason.
      if (amount > Math.max(0, quote.netPaid)) {
        throw new AppError("BUSINESS_RULE_VIOLATION", "refundAboveNetPaid", {
          rule: "BR-73",
          fieldErrors: { refundAmount: "refundAboveNetPaid" },
          details: { netPaid: quote.netPaid },
        });
      }
      if (amount !== quote.suggested && !input.adjustReason) {
        throw new AppError("VALIDATION_ERROR", "adjustReasonRequired", {
          rule: "BR-73",
          fieldErrors: { adjustReason: "adjustReasonRequired" },
          details: { suggested: quote.suggested },
        });
      }
      if (amount > 0) {
        if (!satisfies(actor, "payments.refund")) throw forbidden("refundForbidden", "BR-74");
        if (!input.methodId) {
          throw new AppError("VALIDATION_ERROR", "refundMethodRequired", {
            fieldErrors: { methodId: "refundMethodRequired" },
          });
        }
      }
    }

    const before = await readBookingSnapshot(tx, venueId, booking.id);
    await withdrawPending(tx, actor, deps.now, booking);

    // BR-74: the refund before the status (the cancelled booking takes no payment — 0009).
    if (quote && input.refundAmount > 0) {
      const method = await activeMethodName(tx, venueId, input.methodId!);
      const note = input.adjustReason ?? input.reason;
      const payment = await insertPayment(tx, {
        venueId,
        bookingId: booking.id,
        kind: "refund",
        amount: input.refundAmount,
        methodId: input.methodId!,
        paidAt: deps.now,
        receivedBy: actor.userId,
        note,
      });
      await auditPayment(tx, actor, {
        ...payment,
        bookingId: booking.id,
        bookingNo: booking.bookingNo,
        kind: "refund",
        amount: input.refundAmount,
        paidAt: deps.now,
        method,
        note,
        backdated: false,
      });
      refund = { paymentId: payment.id, receiptNo: payment.receiptNo, amount: input.refundAmount };
    }

    const [row] = await tx
      .update(bookings)
      .set({
        status: "cancelled",
        cancelledAt: deps.now,
        cancelledBy: actor.userId,
        cancelReason: input.reason,
        version: booking.version + 1,
      })
      .where(eq(bookings.id, booking.id))
      .returning({ version: bookings.version });

    await recordAudit(tx, {
      venueId,
      actorId: actor.userId,
      action: "bookings.cancel",
      entityType: "booking",
      entityId: booking.id,
      before,
      after: { ...(await readBookingSnapshot(tx, venueId, booking.id)), cancelReason: input.reason },
      meta: quote
        ? {
            daysRemaining: quote.daysRemaining,
            refundBps: quote.refundBps,
            basis: quote.basis,
            netPaid: quote.netPaid,
            suggested: quote.suggested,
            refund: input.refundAmount,
            ...(input.adjustReason ? { adjustReason: input.adjustReason } : {}),
          }
        : {},
    });
    return {
      version: row.version,
      refund,
      suggested: quote?.suggested ?? 0,
      retained: quote ? Math.max(0, quote.netPaid) - input.refundAmount : 0,
    };
  });
}
