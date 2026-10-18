import { z } from "zod";
import { normalizeEgyptianMobile } from "@/modules/auth/login-id";
import { id, intField, listName } from "@/modules/shared/fields";

// Customers (D-28, D-52, D-106). Mobiles are stored as 01XXXXXXXXX.

/** An Egyptian mobile in any common spelling → 01XXXXXXXXX (D-52). */
export const mobileField = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const phone = normalizeEgyptianMobile(v);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "mobileInvalid" });
      return z.NEVER;
    }
    return phone;
  });

/** Optional mobile: empty or missing → null. */
export const optionalMobileField = z
  .union([z.literal(""), z.null(), mobileField])
  .optional()
  .transform((v) => (typeof v === "string" && v !== "" ? v : null));

/** Optional free text that may also be missing: empty → null. */
export const nullableText = (max: number) =>
  z
    .union([z.null(), z.string().trim().max(max, "tooLong")])
    .optional()
    .transform((v) => (typeof v === "string" && v !== "" ? v : null));

export const customerFields = z.object({
  name: listName,
  phone: mobileField,
  altPhone: optionalMobileField,
  notes: nullableText(500),
});

export type CustomerFields = z.output<typeof customerFields>;

export const lookupSchema = z.object({ phone: mobileField });

export const customerListSchema = z.object({
  search: z.string().trim().max(80, "tooLong").default(""),
  page: intField(1, 100_000).default(1),
});

export const customerIdSchema = z.object({ customerId: id });

export const createCustomerSchema = customerFields;

export const updateCustomerSchema = customerFields.extend({ customerId: id });
