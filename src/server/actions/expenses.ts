"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../action-core";
import { invoke } from "../bind";
import { expenseSpecs } from "../specs/expenses";

/** Expenses (phase 10). Each action runs session → Zod → permission → service (CLAUDE.md rule 6). */

async function run<R>(result: Promise<ActionResult<R>>): Promise<ActionResult<R>> {
  const awaited = await result;
  // S-11 and the booking page read these rows.
  if (awaited.ok) revalidatePath("/", "layout");
  return awaited;
}

export async function createExpenseAction(input: unknown) {
  return run(invoke(expenseSpecs.create, input));
}
export async function voidExpenseAction(input: unknown) {
  return run(invoke(expenseSpecs.void, input));
}
