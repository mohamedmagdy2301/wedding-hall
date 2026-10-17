import { z } from "zod";
import { parsePercent, parsePounds } from "@/domain/money";
import { isTimeOfDay, toHhMm } from "@/domain/slots";
import { toAsciiDigits } from "@/lib/digits";
import { isIsoDate } from "@/lib/time";

/**
 * Zod fields shared by the settings forms and their Server Actions. Messages are i18n keys
 * (errors.messages). Numbers arrive as typed text (Arabic digits allowed) or as numbers.
 */

export const id = z.uuid("invalidId");

/** Settings list names: trimmed, 1–80 characters (P2-14), matching the database checks. */
export const listName = z.string().trim().min(1, "required").max(80, "tooLong");

const numericText = z.union([z.number(), z.string()]).transform((v) => toAsciiDigits(String(v)).trim());

export const intField = (min: number, max: number) =>
  numericText
    .refine((v) => /^\d+$/.test(v), "numberInvalid")
    .transform(Number)
    .refine((n) => n >= min && n <= max, "outOfRange");

/** Optional integer: empty text → null. */
export const optionalIntField = (min: number, max: number) =>
  z
    .union([z.literal(""), z.null(), z.undefined(), intField(min, max)])
    .transform((v) => (typeof v === "number" ? v : null));

/** Pounds as typed → integer piasters (BR-36). */
export const poundsField = numericText.transform((v, ctx) => {
  const piasters = parsePounds(v);
  if (piasters === null) {
    ctx.addIssue({ code: "custom", message: "amountInvalid" });
    return z.NEVER;
  }
  return piasters;
});

/** A percentage as typed → basis points. */
export const percentField = numericText.transform((v, ctx) => {
  const bps = parsePercent(v);
  if (bps === null) {
    ctx.addIssue({ code: "custom", message: "percentInvalid" });
    return z.NEVER;
  }
  return bps;
});

/** "HH:MM" (24-hour). */
export const timeField = z
  .string()
  .trim()
  .transform(toAsciiDigits)
  .refine(isTimeOfDay, "timeInvalid")
  .transform(toHhMm);

/** A calendar date "YYYY-MM-DD". */
export const dateField = z.string().trim().transform(toAsciiDigits).refine(isIsoDate, "dateInvalid");

/** Optional free text: empty → null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "tooLong")
    .transform((v) => (v === "" ? null : v));
