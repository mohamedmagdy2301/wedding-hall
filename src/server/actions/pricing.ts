"use server";

import { invoke } from "../bind";
import { pricingSpecs } from "../specs/pricing";

/** `pricing.quote`: session → Zod → `bookings.view` → service (CLAUDE.md rule 6). Read-only, nothing to revalidate. */
export async function quotePriceAction(input: unknown) {
  return invoke(pricingSpecs.quote, input);
}
