import { and, asc, eq, isNull, max } from "drizzle-orm";
import { bookingItems, bookings, packageItems, packages } from "@/db/schema";
import {
  amendBooking,
  type AmendRequest,
  type AmendViolation,
  type Amendment,
  type StoredLine,
} from "@/domain/amendment";
import { rebalanceSchedule } from "@/domain/installments";
import { activeDeposit } from "@/domain/payments";
import { t } from "@/lib/i18n";
import { recordAudit } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth/sessions";
import { readServices } from "@/modules/catalog/services";
import { insertDiscount } from "@/modules/discounts/service";
import { readLedgerRows, readSchedule } from "@/modules/payments/repository";
import type { ServiceDeps } from "@/modules/shared/context";
import type { DbOrTx, Tx } from "@/modules/shared/db";
import { AppError, notFound, validationError } from "@/modules/shared/errors";
import { runTransaction } from "@/modules/shared/transaction";
import { readSpaceWithTiming } from "@/modules/spaces/service";
import { assertAllowed, satisfies } from "@/modules/users-rbac/authorize";
import { creditOutlook, recordTotalChange } from "./changes";
import type { AmendChanges, PreviewItemsInput, UpdateItemsInput } from "./schemas";
import { assertCapacity, readBookingSnapshot } from "./service";

/**
 * `bookings.previewItems` and `bookings.updateItems` (BR-40..43, UF-07, D-92, D-93, D-128):
 * the lines and guests of a confirmed booking, at current prices for what is added and at
 * the prices on the booking for what comes off. The preview and the save run the same pure
 * function (src/domain/amendment.ts); the save refuses a total other than the one previewed
 * (`PRICE_CHANGED`, like D-124), so nobody saves a price they did not see.
 */

const bookingColumns = {
  id: bookings.id,
  bookingNo: bookings.bookingNo,
  status: bookings.status,
  version: bookings.version,
  spaceId: bookings.spaceId,
  startsAt: bookings.startsAt,
  packageId: bookings.packageId,
  guests: bookings.guests,
  basePrice: bookings.basePrice,
  baseGuests: bookings.baseGuests,
  extraGuestPrice: bookings.extraGuestPrice,
  extraGuestsAmount: bookings.extraGuestsAmount,
  discountAmount: bookings.discountAmount,
  total: bookings.total,
};

type AmendBookingRow = {
  id: string;
  bookingNo: string;
  status: "tentative" | "confirmed" | "cancelled";
  version: number;
  spaceId: string;
  startsAt: Date;
  packageId: string | null;
  guests: number | null;
  basePrice: number | null;
  baseGuests: number | null;
  extraGuestPrice: number | null;
  extraGuestsAmount: number | null;
  discountAmount: number | null;
  total: number | null;
};

async function readAmendBooking(db: DbOrTx, venueId: string, bookingId: string, lock: boolean) {
  const query = db
    .select(bookingColumns)
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.venueId, venueId)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw notFound("bookingNotFound");
  // Tentative bookings are edited whole (D-101); a cancelled one is not edited.
  if (row.status !== "confirmed")
    throw new AppError("BUSINESS_RULE_VIOLATION", "bookingNotConfirmed", { rule: "BR-40" });
  return row as AmendBookingRow & { packageId: string; guests: number; total: number };
}

const VIOLATION_RULES: Partial<Record<AmendViolation, string>> = {
  serviceInactive: "D-87",
  addedDuplicate: "D-90",
  alreadyIncluded: "D-90",
  includedHasAddedUnits: "D-90",
  externalNotAllowed: "BR-34",
  itemNotRemovable: "BR-33",
  negativeTotal: "BR-35",
  discountExceedsSubtotal: "BR-52",
};

function toAppError(violation: AmendViolation, serviceId?: string) {
  if (violation === "serviceUnknown") return notFound("serviceNotFound");
  const rule = VIOLATION_RULES[violation];
  const code = rule ? "BUSINESS_RULE_VIOLATION" : "VALIDATION_ERROR";
  return new AppError(code, violation, {
    rule,
    fieldErrors: { [serviceId ? `changes.${serviceId}` : "changes"]: violation },
  });
}

const toRequest = (changes: AmendChanges): AmendRequest => ({
  guests: changes.guests,
  extraGuestUnitPrice: changes.extraGuestUnitPrice,
  guestServicePrices: new Map(changes.guestServicePrices.map((g) => [g.serviceId, g.unitPrice])),
  add: changes.add,
  remove: changes.remove,
  quantities: changes.quantities,
  removeIncluded: changes.removeIncluded,
  restoreIncluded: changes.restoreIncluded,
});

/** The booking's active lines, oldest first (the stacks of D-128), and the catalog now. */
async function computeAmendment(
  db: DbOrTx,
  venueId: string,
  booking: AmendBookingRow & { packageId: string; guests: number },
  changes: AmendChanges,
) {
  const [lines, pkg, included, services] = await Promise.all([
    db
      .select({
        id: bookingItems.id,
        serviceId: bookingItems.serviceId,
        name: bookingItems.name,
        category: bookingItems.category,
        pricingType: bookingItems.pricingType,
        unitPrice: bookingItems.unitPrice,
        quantity: bookingItems.quantity,
        source: bookingItems.source,
        isRemoved: bookingItems.isRemoved,
        removalCredit: bookingItems.removalCredit,
        isExternal: bookingItems.isExternal,
        externalFee: bookingItems.externalFee,
        lineTotal: bookingItems.lineTotal,
      })
      .from(bookingItems)
      .where(and(eq(bookingItems.bookingId, booking.id), isNull(bookingItems.voidedAt)))
      .orderBy(asc(bookingItems.sortOrder), asc(bookingItems.createdAt)),
    // D-92: the current price even when the package is inactive now.
    db.select({ extraGuestPrice: packages.extraGuestPrice }).from(packages).where(eq(packages.id, booking.packageId)),
    db
      .select({ serviceId: packageItems.serviceId, removable: packageItems.removable })
      .from(packageItems)
      .where(eq(packageItems.packageId, booking.packageId)),
    readServices(db, venueId),
  ]);
  const result = amendBooking(
    lines as StoredLine[],
    {
      guests: booking.guests,
      baseGuests: booking.baseGuests ?? 0,
      extraGuestPrice: booking.extraGuestPrice ?? 0,
      basePrice: booking.basePrice ?? 0,
      extraGuestsAmount: booking.extraGuestsAmount ?? 0,
      discountAmount: booking.discountAmount ?? 0,
    },
    {
      extraGuestPrice: pkg[0].extraGuestPrice,
      services: new Map(services.map((s) => [s.id, s])),
      removable: new Map(included.map((i) => [i.serviceId, i.removable])),
    },
    toRequest(changes),
    t.amend.extraGuestsLine,
  );
  if (!result.ok) throw toAppError(result.violation, result.serviceId);
  return { amendment: result.amendment, lines: lines as StoredLine[] };
}

const sumOf = (items: readonly { amount: number }[]) => items.reduce((s, i) => s + i.amount, 0);

/** The new total: typed-below prices lower it at once only for an approver (BR-41, BR-51). */
function totalsAfter(booking: { discountAmount: number | null }, amendment: Amendment, approver: boolean) {
  const overrideDiscount = sumOf(amendment.overrideDiscounts);
  const discountAmount = (booking.discountAmount ?? 0) + (approver ? overrideDiscount : 0);
  return { discountAmount, overrideDiscount, total: amendment.totals.subtotal - discountAmount };
}

/** BR-52 with the typed-below differences applied. */
function assertDiscountWithinSubtotal(discountAmount: number, subtotal: number) {
  if (discountAmount > subtotal) {
    throw new AppError("BUSINESS_RULE_VIOLATION", "discountExceedsSubtotal", { rule: "BR-52" });
  }
}

const describeLine = (l: {
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  isExternal: boolean;
}) => ({
  name: l.name,
  quantity: l.quantity,
  unitPrice: l.unitPrice,
  lineTotal: l.lineTotal,
  isExternal: l.isExternal,
});

/** `bookings.previewItems` (`bookings.edit`, read-only): before and after, what the schedule and a credit become. */
export async function previewItems(db: DbOrTx, actor: SessionUser, input: PreviewItemsInput) {
  assertAllowed(actor, "bookings.edit");
  const booking = await readAmendBooking(db, actor.venueId, input.bookingId, false);
  const { amendment, lines } = await computeAmendment(db, actor.venueId, booking, input.changes);
  const approver = satisfies(actor, "discounts.approve");
  const after = totalsAfter(booking, amendment, approver);
  const [outlook, schedule, ledgerRows] = await Promise.all([
    creditOutlook(db, actor.venueId, booking.id, after.total),
    readSchedule(db, booking.id),
    readLedgerRows(db, booking.id),
  ]);
  const deposit = activeDeposit(ledgerRows)?.amount ?? 0;
  const installments =
    schedule.length > 0 && after.total !== booking.total
      ? (rebalanceSchedule(schedule, Math.max(0, after.total - deposit)) ?? [])
      : schedule;
  const byId = new Map(lines.map((l) => [l.id, l]));
  return {
    version: booking.version,
    changed: amendment.changed,
    totalBefore: booking.total,
    totalAfter: after.total,
    subtotalAfter: amendment.totals.subtotal,
    discountAmount: after.discountAmount,
    newLines: amendment.newLines.map(describeLine),
    voidedLines: amendment.voidLineIds.map((id) => describeLine(byId.get(id)!)),
    includedChanges: amendment.includedChanges.map((c) => ({ name: byId.get(c.lineId)!.name, ...c })),
    overrideDiscounts: amendment.overrideDiscounts,
    overrideDiscountTotal: after.overrideDiscount,
    overrideApprovedAtOnce: approver,
    overrides: amendment.overrides,
    paid: outlook.paid,
    credit: after.total < booking.total ? outlook.credit : 0,
    creditMode: outlook.mode,
    installments,
    discountProblem: after.discountAmount > amendment.totals.subtotal,
  };
}

export type ItemsPreview = Awaited<ReturnType<typeof previewItems>>;

function changeKind(booking: { guests: number }, changes: AmendChanges, amendment: Amendment) {
  if (amendment.overrides.length > 0 || amendment.overrideDiscounts.length > 0) return "price_override" as const;
  const onlyGuests =
    changes.add.length + changes.remove.length + changes.quantities.length === 0 &&
    changes.removeIncluded.length + changes.restoreIncluded.length === 0;
  return onlyGuests && changes.guests !== booking.guests ? ("guests" as const) : ("items" as const);
}

/** `bookings.updateItems` (`bookings.edit`, + `payments.refund` when a credit is refunded): one transaction. */
export async function updateItems(deps: ServiceDeps, actor: SessionUser, input: UpdateItemsInput) {
  assertAllowed(actor, "bookings.edit");
  const venueId = actor.venueId;
  return runTransaction(deps.db, async (tx) => {
    const booking = await readAmendBooking(tx, venueId, input.bookingId, true);
    if (booking.version !== input.version) throw new AppError("CONCURRENT_MODIFICATION", "bookingChanged");
    const { amendment } = await computeAmendment(tx, venueId, booking, input.changes);
    if (!amendment.changed) throw new AppError("VALIDATION_ERROR", "nothingChanged");

    if (amendment.guests > booking.guests) {
      assertCapacity((await readSpaceWithTiming(tx, venueId, booking.spaceId)).space, amendment.guests);
    }
    const approver = satisfies(actor, "discounts.approve");
    const after = totalsAfter(booking, amendment, approver);
    if (after.overrideDiscount > 0 && !input.overrideReason) {
      throw validationError({ overrideReason: "overrideReasonRequired" }, "overrideReasonRequired");
    }
    if (after.overrideDiscount > 0 && input.overrideReason!.length < 3) {
      throw validationError({ overrideReason: "discountReasonInvalid" }, "discountReasonInvalid");
    }
    assertDiscountWithinSubtotal(after.discountAmount, amendment.totals.subtotal);
    if (after.total !== input.expectedTotal) {
      throw new AppError("PRICE_CHANGED", "priceChanged", {
        rule: "BR-40",
        details: { total: after.total, expectedTotal: input.expectedTotal },
      });
    }

    const before = await readBookingSnapshot(tx, venueId, booking.id);
    const changeId = crypto.randomUUID();
    await writeAmendment(tx, actor, deps.now, booking.id, changeId, amendment);
    const [row] = await tx
      .update(bookings)
      .set({
        guests: amendment.guests,
        extraGuestsAmount: amendment.extraGuestsAmount,
        itemsTotal: amendment.totals.itemsTotal,
        removalCreditsTotal: amendment.totals.removalCreditsTotal,
        discountAmount: after.discountAmount,
        total: after.total,
        version: booking.version + 1,
      })
      .where(eq(bookings.id, booking.id))
      .returning({ version: bookings.version });

    for (const d of amendment.overrideDiscounts) {
      await insertDiscount(tx, actor, deps.now, booking, {
        bookingId: booking.id,
        amount: d.amount,
        reason: `${d.name}: ${input.overrideReason}`.slice(0, 300),
        source: "price_override",
        approved: approver,
      });
    }

    const afterSnapshot = await readBookingSnapshot(tx, venueId, booking.id);
    const kind = changeKind(booking, input.changes, amendment);
    const settled = await recordTotalChange(tx, actor, deps.now, {
      changeId,
      booking,
      kind,
      before,
      after: { ...afterSnapshot, overrides: amendment.overrides, overrideDiscounts: amendment.overrideDiscounts },
      totalBefore: booking.total,
      totalAfter: after.total,
      installments: input.installments,
      credit: input.credit,
    });
    await recordAudit(tx, {
      venueId,
      actorId: actor.userId,
      action: "bookings.update_items",
      entityType: "booking",
      entityId: booking.id,
      before,
      after: afterSnapshot,
      meta: {
        changeId,
        kind,
        ...(amendment.overrides.length > 0 ? { overrides: amendment.overrides } : {}),
        ...(settled.credit > 0 ? { credit: settled.credit, creditResolution: settled.creditResolution } : {}),
      },
    });
    return {
      version: row.version,
      total: after.total,
      pendingDiscount: approver ? 0 : after.overrideDiscount,
      credit: settled.credit,
      creditResolution: settled.creditResolution,
      refund: settled.refund,
      installments: settled.installments,
    };
  });
}

/** The lines of the change (D-128): voided ones stay with the change that voided them, new ones follow the last. */
async function writeAmendment(
  tx: Tx,
  actor: SessionUser,
  now: Date,
  bookingId: string,
  changeId: string,
  a: Amendment,
) {
  for (const lineId of a.voidLineIds) {
    await tx
      .update(bookingItems)
      .set({ voidedAt: now, voidedBy: actor.userId, voidedChangeId: changeId })
      .where(eq(bookingItems.id, lineId));
  }
  for (const c of a.includedChanges) {
    await tx
      .update(bookingItems)
      .set({ isRemoved: c.isRemoved, lineTotal: c.lineTotal })
      .where(eq(bookingItems.id, c.lineId));
  }
  if (a.newLines.length === 0) return;
  const [{ last }] = await tx
    .select({ last: max(bookingItems.sortOrder) })
    .from(bookingItems)
    .where(eq(bookingItems.bookingId, bookingId));
  await tx.insert(bookingItems).values(
    a.newLines.map((line, index) => ({
      venueId: actor.venueId,
      bookingId,
      ...line,
      sortOrder: (last ?? -1) + 1 + index,
      changeId,
    })),
  );
}

/** What the amend dialog chooses from (`bookings.edit`): active services to add, and which included ones may come off now. */
export async function getAmendOptions(db: DbOrTx, actor: SessionUser, packageId: string) {
  assertAllowed(actor, "bookings.edit");
  const [all, included] = await Promise.all([
    readServices(db, actor.venueId),
    db
      .select({ serviceId: packageItems.serviceId, removable: packageItems.removable })
      .from(packageItems)
      .where(and(eq(packageItems.packageId, packageId), eq(packageItems.venueId, actor.venueId))),
  ]);
  return {
    services: all
      .filter((s) => s.isActive)
      .map((s) => ({ id: s.id, name: s.name, pricingType: s.pricingType, allowExternal: s.allowExternal })),
    removable: included.filter((i) => i.removable).map((i) => i.serviceId),
  };
}
