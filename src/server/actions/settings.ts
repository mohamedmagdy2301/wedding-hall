"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "../action-core";
import { invoke } from "../bind";
import { settingsSpecs } from "../specs/settings";
import { spaceSpecs } from "../specs/spaces";

/** S-13 / S-14. Each action runs session → Zod → permission → service on the server (CLAUDE.md rule 6). */

async function run<R>(result: Promise<ActionResult<R>>): Promise<ActionResult<R>> {
  const awaited = await result;
  // The settings tabs, the guided checklist and the home card all read these rows.
  if (awaited.ok) revalidatePath("/", "layout");
  return awaited;
}

export async function updateVenueAction(input: unknown) {
  return run(invoke(settingsSpecs.updateVenue, input));
}
export async function updateTimingAction(input: unknown) {
  return run(invoke(settingsSpecs.updateTiming, input));
}
export async function updatePoliciesAction(input: unknown) {
  return run(invoke(settingsSpecs.updatePolicies, input));
}
export async function createListItemAction(input: unknown) {
  return run(invoke(settingsSpecs.createListItem, input));
}
export async function updateListItemAction(input: unknown) {
  return run(invoke(settingsSpecs.updateListItem, input));
}
export async function setListItemActiveAction(input: unknown) {
  return run(invoke(settingsSpecs.setListItemActive, input));
}
export async function moveListItemAction(input: unknown) {
  return run(invoke(settingsSpecs.moveListItem, input));
}
export async function addSuggestedItemsAction(input: unknown) {
  return run(invoke(settingsSpecs.addSuggestedItems, input));
}
export async function createSeasonAction(input: unknown) {
  return run(invoke(settingsSpecs.createSeason, input));
}
export async function updateSeasonAction(input: unknown) {
  return run(invoke(settingsSpecs.updateSeason, input));
}
export async function setSeasonActiveAction(input: unknown) {
  return run(invoke(settingsSpecs.setSeasonActive, input));
}
export async function createSpaceAction(input: unknown) {
  return run(invoke(spaceSpecs.createSpace, input));
}
export async function updateSpaceAction(input: unknown) {
  return run(invoke(spaceSpecs.updateSpace, input));
}
/** Read-only: the count shown before deactivating a space (D-75). */
export async function spaceUpcomingBookingsAction(input: unknown) {
  return invoke(spaceSpecs.upcomingBookings, input);
}
export async function setSpaceActiveAction(input: unknown) {
  return run(invoke(spaceSpecs.setSpaceActive, input));
}
export async function moveSpaceAction(input: unknown) {
  return run(invoke(spaceSpecs.moveSpace, input));
}
