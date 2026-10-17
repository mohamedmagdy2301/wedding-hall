import { quoteSchema } from "@/modules/pricing/schemas";
import { quote } from "@/modules/pricing/service";
import { defineProtected } from "./define";

/** API.md "Pricing" (`bookings.view`). Read-only; the booking wizard (S-06, phase 5) calls it live. */
export const pricingSpecs = {
  quote: defineProtected({
    schema: quoteSchema,
    requires: "bookings.view",
    handler: (ctx, input) => quote(ctx.db, ctx.actor, input),
  }),
};
