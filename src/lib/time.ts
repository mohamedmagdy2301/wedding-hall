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

const cairoDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: CAIRO_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar date (YYYY-MM-DD) of an instant in Cairo — never the server's zone (T-16). */
export function cairoDate(instant: Date): string {
  return cairoDateFormat.format(instant);
}

/** A real calendar date written as YYYY-MM-DD (rejects 2026-02-30). */
export function isIsoDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

const isoDateFormat = new Intl.DateTimeFormat("ar-EG", { timeZone: "UTC", dateStyle: "medium" });

/** A calendar date (no instant involved) for display: "2026-10-17" → "١٧ أكتوبر ٢٠٢٦". */
export function formatIsoDate(text: string): string {
  return isoDateFormat.format(new Date(`${text}T00:00:00Z`));
}
