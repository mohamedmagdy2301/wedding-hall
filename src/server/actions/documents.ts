"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../action-core";
import { invoke } from "../bind";
import { documentSpecs } from "../specs/documents";

/** Booking documents (phase 9). Each action runs session → Zod → permission → service (CLAUDE.md rule 6). */

async function run<R>(result: Promise<ActionResult<R>>): Promise<ActionResult<R>> {
  const awaited = await result;
  if (awaited.ok) revalidatePath("/", "layout");
  return awaited;
}

export async function uploadDocumentAction(input: unknown) {
  return run(invoke(documentSpecs.upload, input));
}
export async function removeDocumentAction(input: unknown) {
  return run(invoke(documentSpecs.remove, input));
}
/** Opening a document changes nothing on screen (only the audit log), so nothing is revalidated. */
export async function documentViewUrlAction(input: unknown) {
  return invoke(documentSpecs.getViewUrl, input);
}
