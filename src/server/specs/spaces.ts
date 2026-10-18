import { createSpace, moveSpace, setSpaceActive, upcomingBookings, updateSpace } from "@/modules/spaces/service";
import { z } from "zod";
import { createSpaceSchema, moveSpaceSchema, setSpaceActiveSchema, updateSpaceSchema } from "@/modules/spaces/schemas";
import { id } from "@/modules/shared/fields";
import { defineProtected } from "./define";

/** S-13 "الأماكن والفترات" (API.md "Catalog", `catalog.manage`). */
export const spaceSpecs = {
  createSpace: defineProtected({
    schema: createSpaceSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => createSpace(ctx, ctx.actor, input),
  }),
  updateSpace: defineProtected({
    schema: updateSpaceSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => updateSpace(ctx, ctx.actor, input),
  }),
  setSpaceActive: defineProtected({
    schema: setSpaceActiveSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => setSpaceActive(ctx, ctx.actor, input),
  }),
  /** The deactivation warning (D-75, D-112). */
  upcomingBookings: defineProtected({
    schema: z.object({ spaceId: id }),
    requires: "catalog.manage",
    handler: (ctx, input) => upcomingBookings(ctx.db, ctx.actor, input, ctx.now),
  }),
  moveSpace: defineProtected({
    schema: moveSpaceSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => moveSpace(ctx, ctx.actor, input),
  }),
};
