/**
 * The code always uses Cairo time explicitly, never the server's (T-16, CLAUDE.md rule 9).
 * Display formatting uses Intl; date-range filters convert in SQL with AT TIME ZONE.
 */
export const CAIRO_TZ = "Africa/Cairo";

const dateTimeFormat = new Intl.DateTimeFormat("ar-EG", {
  timeZone: CAIRO_TZ,
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatCairoDateTime(value: Date | string): string {
  return dateTimeFormat.format(typeof value === "string" ? new Date(value) : value);
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

export const addMs = (date: Date, ms: number) => new Date(date.getTime() + ms);
