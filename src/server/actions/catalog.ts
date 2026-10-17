"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../action-core";
import { invoke } from "../bind";
import { catalogSpecs } from "../specs/catalog";

/** S-13 services and packages. Each action runs session → Zod → permission → service (CLAUDE.md rule 6). */

async function run<R>(result: Promise<ActionResult<R>>): Promise<ActionResult<R>> {
  const awaited = await result;
  // The catalog tabs, the guided checklist and the home card all read these rows.
  if (awaited.ok) revalidatePath("/", "layout");
  return awaited;
}

export async function createServiceAction(input: unknown) {
  return run(invoke(catalogSpecs.createService, input));
}
export async function updateServiceAction(input: unknown) {
  return run(invoke(catalogSpecs.updateService, input));
}
export async function setServiceActiveAction(input: unknown) {
  return run(invoke(catalogSpecs.setServiceActive, input));
}
export async function createPackageAction(input: unknown) {
  return run(invoke(catalogSpecs.createPackage, input));
}
export async function updatePackageAction(input: unknown) {
  return run(invoke(catalogSpecs.updatePackage, input));
}
export async function setPackageActiveAction(input: unknown) {
  return run(invoke(catalogSpecs.setPackageActive, input));
}
