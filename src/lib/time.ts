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

const isoWeekdayFormat = new Intl.DateTimeFormat("ar-EG", { timeZone: "UTC", weekday: "long" });

/** The weekday of a calendar date for display: "2027-01-15" → "الجمعة". */
export function formatIsoWeekday(text: string): string {
  return isoWeekdayFormat.format(new Date(`${text}T00:00:00Z`));
}

const timeFormat = new Intl.DateTimeFormat("ar-EG", { timeZone: CAIRO_TZ, timeStyle: "short" });

/** The Cairo time of an instant for display: "٨:٠٠ م". */
export function formatCairoTime(value: Date | string): string {
  return timeFormat.format(typeof value === "string" ? new Date(value) : value);
}

/** YYYY-MM-DD shifted by whole days (calendar arithmetic, no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** YYYY-MM-DD shifted by whole years; 29 February rolls to 1 March. */
export function addYears(date: string, years: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y + years, m - 1, d)).toISOString().slice(0, 10);
}

/** The Cairo calendar year of an instant (BR-26). */
export const cairoYear = (instant: Date) => Number(cairoDate(instant).slice(0, 4));

const wallClockFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: CAIRO_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Cairo's UTC offset (ms) at an instant: +2h in winter, +3h in summer time. */
function cairoOffsetMs(instant: number): number {
  const parts = Object.fromEntries(wallClockFormat.formatToParts(instant).map((p) => [p.type, p.value]));
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** "HH:MM" of an instant on Cairo's wall clock. */
export function cairoTimeOfDay(instant: Date): string {
  const parts = Object.fromEntries(wallClockFormat.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts.hour}:${parts.minute}`;
}

/**
 * The instant of a Cairo wall-clock time on a calendar date (D-100), resolved exactly like
 * PostgreSQL's `(date + time) AT TIME ZONE 'Africa/Cairo'`:
 * - a time that does not exist (the hour skipped when summer time starts) moves forward
 *   by the gap — it is read with the offset in force before the change;
 * - a time that happens twice (the hour repeated when summer time ends) is the second
 *   occurrence, in standard time.
 * Egypt changes its clock at most once within any 48 hours, so the offsets a day before
 * and a day after cover both readings.
 */
export function cairoInstant(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const before = cairoOffsetMs(wall - DAY_MS);
  const after = cairoOffsetMs(wall + DAY_MS);
  const valid = [wall - before, wall - after].filter((t) => t + cairoOffsetMs(t) === wall);
  if (valid.length === 0) return new Date(wall - before);
  return new Date(Math.max(...valid));
}

const isoMonthFormat = new Intl.DateTimeFormat("ar-EG", { timeZone: "UTC", month: "long", year: "numeric" });

/** The month of a calendar date for display: "2026-10-18" → "أكتوبر ٢٠٢٦". */
export function formatIsoMonth(text: string): string {
  return isoMonthFormat.format(new Date(`${text.slice(0, 7)}-01T00:00:00Z`));
}
