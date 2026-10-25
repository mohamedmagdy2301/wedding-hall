import { calendar, checkAvailability } from "@/modules/bookings/availability";
import { getBooking, listBookings } from "@/modules/bookings/queries";
import {
  availabilityCheckSchema,
  bookingIdSchema,
  bookingListSchema,
  calendarSchema,
  cancelSchema,
  confirmSchema,
  createConfirmedSchema,
  createTentativeSchema,
  extendTentativeSchema,
  postponePreviewSchema,
  postponeSchema,
  previewItemsSchema,
  updateDetailsSchema,
  updateItemsSchema,
  updateTentativeSchema,
} from "@/modules/bookings/schemas";
import { previewItems, updateItems } from "@/modules/bookings/amend";
import { cancelBooking, cancelPreview } from "@/modules/bookings/cancel";
import { confirmBooking, createConfirmed } from "@/modules/bookings/confirm";
import { postponeBooking, postponePreview } from "@/modules/bookings/postpone";
import { createTentative, extendTentative, updateDetails, updateTentative } from "@/modules/bookings/service";
import {
  createCustomerSchema,
  customerIdSchema,
  customerListSchema,
  lookupSchema,
  updateCustomerSchema,
} from "@/modules/customers/schemas";
import { createCustomer, getCustomer, listCustomers, lookupByPhone, updateCustomer } from "@/modules/customers/service";
import { defineProtected } from "./define";

/**
 * API.md "Bookings", "Availability" and "Customers" (phases 5 and 6). Confirming needs
 * payments.record too, checked by the service (D-123).
 */
export const bookingSpecs = {
  createTentative: defineProtected({
    schema: createTentativeSchema,
    requires: "bookings.create",
    handler: (ctx, input) => createTentative(ctx, ctx.actor, input),
  }),
  updateTentative: defineProtected({
    schema: updateTentativeSchema,
    requires: "bookings.edit",
    handler: (ctx, input) => updateTentative(ctx, ctx.actor, input),
  }),
  extendTentative: defineProtected({
    schema: extendTentativeSchema,
    requires: "bookings.edit",
    handler: (ctx, input) => extendTentative(ctx, ctx.actor, input),
  }),
  confirm: defineProtected({
    schema: confirmSchema,
    requires: "bookings.confirm",
    handler: (ctx, input) => confirmBooking(ctx, ctx.actor, input),
  }),
  createConfirmed: defineProtected({
    schema: createConfirmedSchema,
    requires: "bookings.create",
    handler: (ctx, input) => createConfirmed(ctx, ctx.actor, input),
  }),
  updateDetails: defineProtected({
    schema: updateDetailsSchema,
    requires: "bookings.edit",
    handler: (ctx, input) => updateDetails(ctx, ctx.actor, input),
  }),
  // Phase 7 (BR-40..43): read-only preview and the save; a refund needs payments.refund too (service).
  previewItems: defineProtected({
    schema: previewItemsSchema,
    requires: "bookings.edit",
    handler: (ctx, input) => previewItems(ctx.db, ctx.actor, input),
  }),
  updateItems: defineProtected({
    schema: updateItemsSchema,
    requires: "bookings.edit",
    handler: (ctx, input) => updateItems(ctx, ctx.actor, input),
  }),
  // Phase 8 (BR-70..85). A tentative booking is cancelled by bookings.edit or bookings.cancel,
  // a confirmed one by bookings.cancel (Q8-05); a refund needs payments.refund too (services).
  cancelPreview: defineProtected({
    schema: bookingIdSchema,
    requires: "authenticated",
    handler: (ctx, input) => cancelPreview(ctx.db, ctx.actor, input.bookingId, ctx.now),
  }),
  cancel: defineProtected({
    schema: cancelSchema,
    requires: "authenticated",
    handler: (ctx, input) => cancelBooking(ctx, ctx.actor, input),
  }),
  postponePreview: defineProtected({
    schema: postponePreviewSchema,
    requires: "bookings.postpone",
    handler: (ctx, input) => postponePreview(ctx.db, ctx.actor, input, ctx.now),
  }),
  postpone: defineProtected({
    schema: postponeSchema,
    requires: "bookings.postpone",
    handler: (ctx, input) => postponeBooking(ctx, ctx.actor, input),
  }),
  get: defineProtected({
    schema: bookingIdSchema,
    requires: "bookings.view",
    handler: (ctx, input) => getBooking(ctx.db, ctx.actor, input.bookingId, ctx.now),
  }),
  list: defineProtected({
    schema: bookingListSchema,
    requires: "bookings.view",
    handler: (ctx, input) => listBookings(ctx.db, ctx.actor, input, ctx.now),
  }),
};

export const availabilitySpecs = {
  check: defineProtected({
    schema: availabilityCheckSchema,
    requires: "bookings.view",
    handler: (ctx, input) => checkAvailability(ctx.db, ctx.actor, input, ctx.now),
  }),
  calendar: defineProtected({
    schema: calendarSchema,
    requires: "bookings.view",
    handler: (ctx, input) => calendar(ctx.db, ctx.actor, input, ctx.now),
  }),
};

export const customerSpecs = {
  lookupByPhone: defineProtected({
    schema: lookupSchema,
    requires: "bookings.create",
    handler: (ctx, input) => lookupByPhone(ctx.db, ctx.actor, input),
  }),
  list: defineProtected({
    schema: customerListSchema,
    requires: "bookings.view",
    handler: (ctx, input) => listCustomers(ctx.db, ctx.actor, input),
  }),
  get: defineProtected({
    schema: customerIdSchema,
    requires: "bookings.view",
    handler: (ctx, input) => getCustomer(ctx.db, ctx.actor, input.customerId, ctx.now),
  }),
  create: defineProtected({
    schema: createCustomerSchema,
    requires: "customers.manage",
    handler: (ctx, input) => createCustomer(ctx, ctx.actor, input),
  }),
  update: defineProtected({
    schema: updateCustomerSchema,
    requires: "customers.manage",
    handler: (ctx, input) => updateCustomer(ctx, ctx.actor, input),
  }),
};
