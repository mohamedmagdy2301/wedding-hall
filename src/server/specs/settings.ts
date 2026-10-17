import {
  addSuggestedItems,
  createListItem,
  moveListItem,
  setListItemActive,
  updateListItem,
} from "@/modules/settings/lists";
import {
  createListItemSchema,
  createSeasonSchema,
  listKindSchema,
  moveListItemSchema,
  setListItemActiveSchema,
  setSeasonActiveSchema,
  updateListItemSchema,
  updatePoliciesSchema,
  updateSeasonSchema,
  updateTimingSchema,
  updateVenueSchema,
} from "@/modules/settings/schemas";
import { createSeason, setSeasonActive, updateSeason } from "@/modules/settings/seasons";
import { updatePolicies, updateTiming, updateVenue } from "@/modules/settings/venue";
import { AppError } from "@/modules/shared/errors";
import { defineProtected } from "./define";

/** S-13 / UF-02 (API.md "Settings"; seasons under "Catalog", D-66). */
export const settingsSpecs = {
  updateVenue: defineProtected({
    schema: updateVenueSchema,
    requires: "settings.manage",
    handler: (ctx, input) => updateVenue(ctx, ctx.actor, input),
  }),
  updateTiming: defineProtected({
    schema: updateTimingSchema,
    requires: "settings.manage",
    handler: (ctx, input) => updateTiming(ctx, ctx.actor, input),
  }),
  updatePolicies: defineProtected({
    schema: updatePoliciesSchema,
    requires: "settings.manage",
    handler: (ctx, input) => updatePolicies(ctx, ctx.actor, input),
  }),
  createListItem: defineProtected({
    schema: createListItemSchema,
    requires: "settings.manage",
    handler: (ctx, input) => createListItem(ctx, ctx.actor, input),
  }),
  updateListItem: defineProtected({
    schema: updateListItemSchema,
    requires: "settings.manage",
    handler: (ctx, input) => updateListItem(ctx, ctx.actor, input),
  }),
  setListItemActive: defineProtected({
    schema: setListItemActiveSchema,
    requires: "settings.manage",
    handler: (ctx, input) => setListItemActive(ctx, ctx.actor, input),
  }),
  moveListItem: defineProtected({
    schema: moveListItemSchema,
    requires: "settings.manage",
    handler: (ctx, input) => {
      // Expense categories are listed by name (DATA_MODEL §1).
      if (input.kind === "expenseCategories") throw new AppError("VALIDATION_ERROR", "validation");
      return moveListItem(ctx, ctx.actor, { ...input, kind: input.kind });
    },
  }),
  addSuggestedItems: defineProtected({
    schema: listKindSchema,
    requires: "settings.manage",
    handler: (ctx, input) => addSuggestedItems(ctx, ctx.actor, input),
  }),
  createSeason: defineProtected({
    schema: createSeasonSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => createSeason(ctx, ctx.actor, input),
  }),
  updateSeason: defineProtected({
    schema: updateSeasonSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => updateSeason(ctx, ctx.actor, input),
  }),
  setSeasonActive: defineProtected({
    schema: setSeasonActiveSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => setSeasonActive(ctx, ctx.actor, input),
  }),
};
