"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../action-core";
import { invoke } from "../bind";
import { paymentSpecs } from "../specs/payments";

/** Payments and the schedule (phase 6). Each action runs session → Zod → permission → service (CLAUDE.md rule 6). */

async function run<R>(result: Promise<ActionResult<R>>): Promise<ActionResult<R>> {
  const awaited = await result;
  // The booking page, the lists and collections read these rows.
  if (awaited.ok) revalidatePath("/", "layout");
  return awaited;
}

export async function recordPaymentAction(input: unknown) {
  return run(invoke(paymentSpecs.record, input));
}
export async function recordDepositAction(input: unknown) {
  return run(invoke(paymentSpecs.recordDeposit, input));
}
export async function voidPaymentAction(input: unknown) {
  return run(invoke(paymentSpecs.void, input));
}
export async function refundCreditAction(input: unknown) {
  return run(invoke(paymentSpecs.refund, input));
}
export async function setInstallmentsAction(input: unknown) {
  return run(invoke(paymentSpecs.setInstallments, input));
}
