import { z } from "zod";
import { DISPLAY_STATUSES } from "@/domain/booking-status";
import { MAX_ITEM_QUANTITY, SLOT_KINDS } from "@/domain/catalog";
import { MAX_PIASTERS } from "@/domain/money";
import { MAX_GUESTS, MAX_QUOTE_ITEMS } from "@/domain/pricing";
import { addDays } from "@/lib/time";
import { mobileField, nullableText, optionalMobileField } from "@/modules/customers/schemas";
import { depositSchema, scheduleSchema } from "@/modules/payments/schemas";
import { dateField, id, intField, listName, optionalIntField, timeField } from "@/modules/shared/fields";

// API.md "Bookings" and "Availability" (D-99, D-101, D-106).

/** The longest calendar range: a month grid of six weeks. */
export const MAX_CALENDAR_DAYS = 42;

// `.optional()`: Zod 4 treats a missing key as optional only when the schema says so.
const optionalTime = z
  .union([z.literal(""), z.null(), timeField])
  .optional()
  .transform((v) => (typeof v === "string" && v !== "" ? v : null));

const optionalId = z
  .union([z.literal(""), z.null(), id])
  .optional()
  .transform((v) => (typeof v === "string" && v !== "" ? v : null));

const version = intField(1, 2_147_483_647);

const addedItem = z.object({
  serviceId: id,
  quantity: intField(1, MAX_ITEM_QUANTITY),
  isExternal: z.boolean(),
});

/** An existing customer to link, or a new one created with the booking (D-28, D-106). */
const customerChoice = z.union([
  z.object({ customerId: id }),
  z.object({ name: listName, phone: mobileField, altPhone: optionalMobileField }),
]);

const slotFields = {
  spaceId: id,
  eventDate: dateField,
  slotKind: z.enum(SLOT_KINDS),
  startTime: optionalTime,
  endTime: optionalTime,
};

const bookingObject = z.object({
  ...slotFields,
  customer: customerChoice,
  eventTypeId: optionalId,
  groomName: nullableText(80),
  brideName: nullableText(80),
  packageId: optionalId,
  guests: optionalIntField(1, MAX_GUESTS)
    .optional()
    .transform((v) => v ?? null),
  items: z.array(addedItem).max(MAX_QUOTE_ITEMS, "tooMany").default([]),
  removedServiceIds: z.array(id).max(MAX_QUOTE_ITEMS, "tooMany").default([]),
  notes: nullableText(1000),
});

/** D-09: the minimum is the customer, the space, the date and the slot. A package needs guests (D-103). */
function packageRules(value: z.output<typeof bookingObject>, ctx: z.RefinementCtx) {
  if (value.packageId && value.guests === null) {
    ctx.addIssue({ code: "custom", path: ["guests"], message: "guestsRequiredWithPackage" });
  }
  if (!value.packageId && (value.items.length > 0 || value.removedServiceIds.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["packageId"], message: "packageRequiredForItems" });
  }
}

export const createTentativeSchema = bookingObject.superRefine(packageRules);
export type BookingInput = z.output<typeof createTentativeSchema>;

export const updateTentativeSchema = bookingObject
  .extend({ bookingId: id, version })
  .superRefine((value, ctx) => packageRules(value, ctx));
export type UpdateTentativeInput = z.output<typeof updateTentativeSchema>;

/** What confirming adds (D-124, D-127): the total seen, in piasters as quoted; the deposit and schedule as typed. */
const confirmFields = {
  expectedTotal: intField(0, MAX_PIASTERS),
  deposit: depositSchema,
  installments: scheduleSchema.default([]),
};

export const confirmSchema = z.object({ bookingId: id, version, ...confirmFields });

export const createConfirmedSchema = bookingObject.extend(confirmFields).superRefine(packageRules);

export const extendTentativeSchema = z.object({ bookingId: id, version });

export const updateDetailsSchema = z.object({
  bookingId: id,
  version,
  customerId: id,
  eventTypeId: optionalId,
  groomName: nullableText(80),
  brideName: nullableText(80),
  notes: nullableText(1000),
});
export type UpdateDetailsInput = z.output<typeof updateDetailsSchema>;

export const bookingIdSchema = z.object({ bookingId: id });

export const bookingListSchema = z.object({
  search: z.string().trim().max(80, "tooLong").default(""),
  status: z.union([z.literal(""), z.enum(DISPLAY_STATUSES)]).default(""),
  spaceId: optionalId,
  slotKind: z.union([z.literal(""), z.enum(SLOT_KINDS)]).default(""),
  from: z.union([z.literal(""), dateField]).default(""),
  to: z.union([z.literal(""), dateField]).default(""),
  balance: z.union([z.literal(""), z.literal("due")]).default(""),
  page: intField(1, 100_000).default(1),
});
export type BookingListFilters = z.output<typeof bookingListSchema>;

export const availabilityCheckSchema = z.object({ ...slotFields, excludeBookingId: optionalId });
export type AvailabilityInput = z.output<typeof availabilityCheckSchema>;

export const calendarSchema = z
  .object({ spaceIds: z.array(id).max(100, "tooMany").default([]), from: dateField, to: dateField })
  .refine((v) => v.from <= v.to && v.to < addDays(v.from, MAX_CALENDAR_DAYS), {
    path: ["to"],
    message: "calendarRangeInvalid",
  });
export type CalendarInput = z.output<typeof calendarSchema>;
