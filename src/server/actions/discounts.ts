"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../action-core";
import { invoke } from "../bind";
import { discountSpecs } from "../specs/discounts";

/** Discounts (phase 7). Each action runs session → Zod → permission → service (CLAUDE.md rule 6). */

async function run<R>(result: Promise<ActionResult<R>>): Promise<ActionResult<R>> {
  const awaited = await result;
  // The booking page, the lists and the approvals screen read these rows.
  if (awaited.ok) revalidatePath("/", "layout");
  return awaited;
}

export async function requestDiscountAction(input: unknown) {
  return run(invoke(discountSpecs.request, input));
}
export async function decideDiscountAction(input: unknown) {
  return run(invoke(discountSpecs.decide, input));
}
export async function withdrawDiscountAction(input: unknown) {
  return run(invoke(discountSpecs.withdraw, input));
}
