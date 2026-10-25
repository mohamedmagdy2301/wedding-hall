import { and, eq } from "drizzle-orm";
import { bookingItems, bookings, eventTypes } from "@/db/schema";
import { depositViolation, minimumDeposit } from "@/domain/deposit";
import { cairoDate } from "@/lib/time";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { activeMethodName, insertPayment, replaceSchedule } from "@/modules/payments/repository";
import type { DepositInput } from "@/modules/payments/schemas";
import { assertSchedule, auditPayment, resolvePaidAt } from "@/modules/payments/service";
import { quoteForVenue } from "@/modules/pricing/service";
import { bookingReadiness } from "@/modules/settings/checklist";
import { readVenuePolicies } from "@/modules/settings/venue";
import type { ServiceDeps } from "@/modules/shared/context";
import type { Tx } from "@/modules/shared/db";
import { AppError, notFound, ruleViolation } from "@/modules/shared/errors";
import { runTransaction } from "@/modules/shared/transaction";
import { assertAllowed } from "@/modules/users-rbac/authorize";
import { approvedDiscount } from "./changes";
import { requestedQuantity } from "./repository";
import { markConfirmed } from "./confirm-transition";
import { queueOnSpace } from "./space-queue";
import type { BookingInput } from "./schemas";
import {
  assertActiveSpace,
  assertCapacity,
  insertLines,
  insertTentative,
  loadSpace,
  lockBooking,
  priceColumns,
  readBookingSnapshot,
} from "./service";

/**
 * `bookings.confirm` and `bookings.createConfirmed` (BR-21..23, D-41, D-95, D-110, D-119,
 * D-124, D-127): the one caller of `markConfirmed`. Everything — the re-pricing, the price
 * and policy snapshots, the deposit with its receipt number, the schedule and the audit —
 * is one transaction (BR-22), so a refusal at any step, the slot clash included, leaves no
 * deposit without a confirmation and no confirmation without a deposit.
 *
 * Lock order: the space's queue first (D-115), then the booking row, and the receipt
 * counter last (D-125) — the same order as every other confirmation and payment.
 */

export type ConfirmInput = {
  bookingId: string;
  version: number;
  /** The total the staff member saw and confirmed (D-124). */
  expectedTotal: number;
  deposit: DepositInput;
  installments: { dueDate: string; amount: number }[];
};

export type CreateConfirmedInput = BookingInput & Omit<ConfirmInput, "bookingId" | "version">;

const required = "required";

/** The booking's own choices, re-priced at confirmation from the current catalog (D-95). */
async function storedItems(tx: Tx, bookingId: string) {
  const lines = await tx
    .select({
      serviceId: bookingItems.serviceId,
      quantity: bookingItems.quantity,
      pricingType: bookingItems.pricingType,
      source: bookingItems.source,
      isRemoved: bookingItems.isRemoved,
      isExternal: bookingItems.isExternal,
    })
    .from(bookingItems)
    .where(eq(bookingItems.bookingId, bookingId))
    .orderBy(bookingItems.sortOrder);
  return {
    items: lines
      .filter((l) => l.source === "added" && l.serviceId)
      .map((l) => ({ serviceId: l.serviceId!, quantity: requestedQuantity(l), isExternal: l.isExternal })),
    removedServiceIds: lines.filter((l) => l.isRemoved && l.serviceId).map((l) => l.serviceId!),
  };
}

async function confirmInTx(tx: Tx, deps: ServiceDeps, actor: SessionUser, input: ConfirmInput) {
  const venueId = actor.venueId;
  const when = resolvePaidAt(actor, input.deposit.paidAt, deps.now);

  const [head] = await tx
    .select({ spaceId: bookings.spaceId })
    .from(bookings)
    .where(and(eq(bookings.id, input.bookingId), eq(bookings.venueId, venueId)));
  if (!head) throw notFound("bookingNotFound");
  await queueOnSpace(tx, head.spaceId);
  const current = await lockBooking(tx, venueId, input.bookingId, input.version);
  if (current.status !== "tentative") throw ruleViolation("BR-21", "bookingNotTentative");

  // BR-21 item 5: the venue's setup (cancellation tiers among it — D-60, D-67).
  if (!(await bookingReadiness(tx, venueId)).ready) throw ruleViolation("BR-21", "venueNotReady");

  // BR-21 item 2: the basic data.
  const [details] = await tx
    .select({
      groomName: bookings.groomName,
      brideName: bookings.brideName,
      total: bookings.total,
      bookingNo: bookings.bookingNo,
      isWedding: eventTypes.isWedding,
    })
    .from(bookings)
    .leftJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
    .where(eq(bookings.id, current.id));
  const missing: Record<string, string> = {};
  if (!current.eventTypeId) missing.eventTypeId = required;
  if (!current.packageId) missing.packageId = required;
  if (current.guests === null) missing.guests = required;
  if (details.isWedding && !details.groomName) missing.groomName = required;
  if (details.isWedding && !details.brideName) missing.brideName = required;
  if (Object.keys(missing).length > 0) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "bookingIncomplete", { rule: "BR-21", fieldErrors: missing });
  }

  // BR-06, BR-05 and the start still ahead (BR-27); the slot itself is the constraint's call (item 3, 4).
  const { space, timing } = await loadSpace(tx, venueId, current.spaceId);
  assertActiveSpace(space);
  if (current.startsAt <= deps.now) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "startPassed", { rule: "BR-27" });
  }
  assertCapacity(space, current.guests);

  // D-41, D-95: the whole booking at current prices; a different total is shown, not applied (D-124).
  const price = await quoteForVenue(tx, venueId, {
    spaceId: current.spaceId,
    packageId: current.packageId!,
    slotKind: current.slotKind,
    eventDate: cairoDate(current.startsAt),
    guests: current.guests!,
    ...(await storedItems(tx, current.id)),
    // Q7-01: approved discounts stay; BR-52 refuses the confirmation if they no longer fit.
    discountAmount: await approvedDiscount(tx, current.id),
  });
  if (price.total !== input.expectedTotal) {
    throw new AppError("PRICE_CHANGED", "priceChanged", {
      rule: "D-41",
      details: { total: price.total, previousTotal: details.total, expectedTotal: input.expectedTotal, price },
    });
  }

  // BR-21 item 1, BR-63, D-119.
  const policies = await readVenuePolicies(tx, venueId);
  const depositProblem = depositViolation(price.total, policies, input.deposit.amount);
  if (depositProblem) {
    throw new AppError("BUSINESS_RULE_VIOLATION", depositProblem, {
      rule: depositProblem === "depositBelowMinimum" ? "BR-21" : "BR-63",
      fieldErrors: { "deposit.amount": depositProblem },
      details: { minimum: minimumDeposit(price.total, policies) },
    });
  }
  const method = await activeMethodName(tx, venueId, input.deposit.methodId);
  assertSchedule({
    total: price.total,
    deposit: input.deposit.amount,
    eventDate: cairoDate(current.startsAt),
    lines: input.installments,
  });

  await tx.update(bookings).set(priceColumns(price)).where(eq(bookings.id, current.id));
  await tx.delete(bookingItems).where(eq(bookingItems.bookingId, current.id));
  await insertLines(tx, venueId, current.id, price);

  const { version } = await markConfirmed(tx, {
    venueId,
    bookingId: current.id,
    confirmedBy: actor.userId,
    now: deps.now,
    bufferMinutes: timing.bufferMinutes,
    cancellationBasis: policies.cancellationBasis,
    cancellationTiers: policies.tiers,
  });

  const payment = await insertPayment(tx, {
    venueId,
    bookingId: current.id,
    kind: "deposit",
    amount: input.deposit.amount,
    methodId: input.deposit.methodId,
    paidAt: when.paidAt,
    receivedBy: actor.userId,
    note: null,
  });
  await auditPayment(tx, actor, {
    ...payment,
    bookingId: current.id,
    bookingNo: details.bookingNo,
    kind: "deposit",
    amount: input.deposit.amount,
    paidAt: when.paidAt,
    method,
    note: null,
    backdated: when.backdated,
  });
  await replaceSchedule(tx, venueId, current.id, input.installments);

  return {
    version,
    bookingNo: details.bookingNo,
    paymentId: payment.id,
    receiptNo: payment.receiptNo,
    total: price.total,
    previousTotal: details.total,
  };
}

function assertConfirmPermissions(actor: SessionUser) {
  assertAllowed(actor, "bookings.confirm");
  assertAllowed(actor, "payments.record");
}

/** `bookings.confirm` (BR-21, BR-22): confirm + payments.record, and payments.backdate for a past deposit date (D-118, D-123). */
export async function confirmBooking(deps: ServiceDeps, actor: SessionUser, input: ConfirmInput) {
  assertConfirmPermissions(actor);
  return runTransaction(deps.db, async (tx) => {
    const before = await readBookingSnapshot(tx, actor.venueId, input.bookingId);
    const result = await confirmInTx(tx, deps, actor, input);
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "bookings.confirm",
      entityType: "booking",
      entityId: input.bookingId,
      before,
      after: await readBookingSnapshot(tx, actor.venueId, input.bookingId),
      meta: {
        receiptNo: result.receiptNo,
        deposit: input.deposit.amount,
        installments: input.installments,
        previousTotal: result.previousTotal,
      },
    });
    return result;
  });
}

/** `bookings.createConfirmed` (BR-23): create + confirm + payments.record (D-123), one transaction. */
export async function createConfirmed(deps: ServiceDeps, actor: SessionUser, input: CreateConfirmedInput) {
  assertAllowed(actor, "bookings.create");
  assertConfirmPermissions(actor);
  return runTransaction(deps.db, async (tx) => {
    // The space's queue before anything else (D-115), as in every confirmation.
    await queueOnSpace(tx, input.spaceId);
    const created = await insertTentative(tx, deps, actor, input);
    const result = await confirmInTx(tx, deps, actor, {
      bookingId: created.id,
      version: created.version,
      expectedTotal: input.expectedTotal,
      deposit: input.deposit,
      installments: input.installments,
    });
    await recordAudit(tx, {
      venueId: actor.venueId,
      actorId: actor.userId,
      action: "bookings.create_confirmed",
      entityType: "booking",
      entityId: created.id,
      after: await readBookingSnapshot(tx, actor.venueId, created.id),
      meta: { receiptNo: result.receiptNo, deposit: input.deposit.amount, installments: input.installments },
    });
    return { id: created.id, warnings: created.warnings, ...result };
  });
}
