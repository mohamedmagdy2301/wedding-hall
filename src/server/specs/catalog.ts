import {
  createPackageSchema,
  createServiceSchema,
  setPackageActiveSchema,
  setServiceActiveSchema,
  updatePackageSchema,
  updateServiceSchema,
} from "@/modules/catalog/schemas";
import { createService, setServiceActive, updateService } from "@/modules/catalog/services";
import { createPackage, setPackageActive, updatePackage } from "@/modules/packages/service";
import { defineProtected } from "./define";

/** S-13 "الخدمات" and "الباكيجات" (API.md "Catalog", `catalog.manage`). No delete operations (D-82). */
export const catalogSpecs = {
  createService: defineProtected({
    schema: createServiceSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => createService(ctx, ctx.actor, input),
  }),
  updateService: defineProtected({
    schema: updateServiceSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => updateService(ctx, ctx.actor, input),
  }),
  setServiceActive: defineProtected({
    schema: setServiceActiveSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => setServiceActive(ctx, ctx.actor, input),
  }),
  createPackage: defineProtected({
    schema: createPackageSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => createPackage(ctx, ctx.actor, input),
  }),
  updatePackage: defineProtected({
    schema: updatePackageSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => updatePackage(ctx, ctx.actor, input),
  }),
  setPackageActive: defineProtected({
    schema: setPackageActiveSchema,
    requires: "catalog.manage",
    handler: (ctx, input) => setPackageActive(ctx, ctx.actor, input),
  }),
};
