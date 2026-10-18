"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../action-core";
import { invoke } from "../bind";
import { availabilitySpecs, bookingSpecs, customerSpecs } from "../specs/bookings";

/**
 * Bookings, availability and customers (phase 5). Each action runs session → Zod →
 * permission → service on the server (CLAUDE.md rule 6). No confirm action: phase 6 (D-97).
 */

async function run<R>(result: Promise<ActionResult<R>>): Promise<ActionResult<R>> {
  const awaited = await result;
  // The calendar, the lists and the booking and customer pages read these rows.
  if (awaited.ok) revalidatePath("/", "layout");
  return awaited;
}

export async function createTentativeAction(input: unknown) {
  return run(invoke(bookingSpecs.createTentative, input));
}
export async function updateTentativeAction(input: unknown) {
  return run(invoke(bookingSpecs.updateTentative, input));
}
export async function extendTentativeAction(input: unknown) {
  return run(invoke(bookingSpecs.extendTentative, input));
}
export async function updateBookingDetailsAction(input: unknown) {
  return run(invoke(bookingSpecs.updateDetails, input));
}

/** Read-only, called live by the wizard while it is filled in. */
export async function checkAvailabilityAction(input: unknown) {
  return invoke(availabilitySpecs.check, input);
}
export async function calendarAction(input: unknown) {
  return invoke(availabilitySpecs.calendar, input);
}
export async function lookupCustomerAction(input: unknown) {
  return invoke(customerSpecs.lookupByPhone, input);
}

export async function createCustomerAction(input: unknown) {
  return run(invoke(customerSpecs.create, input));
}
export async function updateCustomerAction(input: unknown) {
  return run(invoke(customerSpecs.update, input));
}
