import { listPendingDiscounts } from "@/modules/discounts/queries";
import {
  decideDiscountSchema,
  listPendingSchema,
  requestDiscountSchema,
  withdrawDiscountSchema,
} from "@/modules/discounts/schemas";
import { decideDiscount, requestDiscount, withdrawDiscount } from "@/modules/discounts/service";
import { defineProtected } from "./define";

/** API.md "Discounts" (phase 7, BR-50..52, D-129). Withdrawing is checked by the service (Q7-03). */
export const discountSpecs = {
  request: defineProtected({
    schema: requestDiscountSchema,
    requires: "discounts.request",
    handler: (ctx, input) => requestDiscount(ctx, ctx.actor, input),
  }),
  decide: defineProtected({
    schema: decideDiscountSchema,
    requires: "discounts.approve",
    handler: (ctx, input) => decideDiscount(ctx, ctx.actor, input),
  }),
  withdraw: defineProtected({
    schema: withdrawDiscountSchema,
    requires: "authenticated",
    handler: (ctx, input) => withdrawDiscount(ctx, ctx.actor, input),
  }),
  listPending: defineProtected({
    schema: listPendingSchema,
    requires: "discounts.approve",
    handler: (ctx) => listPendingDiscounts(ctx.db, ctx.actor),
  }),
};
