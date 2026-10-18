import { calendar, checkAvailability } from "@/modules/bookings/availability";
import { getBooking, listBookings } from "@/modules/bookings/queries";
import {
  availabilityCheckSchema,
  bookingIdSchema,
  bookingListSchema,
  calendarSchema,
  confirmSchema,
  createConfirmedSchema,
  createTentativeSchema,
  extendTentativeSchema,
  updateDetailsSchema,
  updateTentativeSchema,
} from "@/modules/bookings/schemas";
import { confirmBooking, createConfirmed } from "@/modules/bookings/confirm";
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
