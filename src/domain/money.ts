import { toAsciiDigits } from "@/lib/digits";

/**
 * Money is an integer number of piasters everywhere (BR-36, CLAUDE.md rule 1). Typed amounts
 * are parsed as text — never through a floating-point number — and formatting is for
 * display only. Percentages are basis points (1% = 100 bps).
 */

export const PIASTERS_PER_POUND = 100;
/** One billion pounds: far above any booking, well inside Number.MAX_SAFE_INTEGER. */
export const MAX_PIASTERS = 1_000_000_000 * PIASTERS_PER_POUND;
export const MAX_BPS = 10_000;

/** Digits with an optional fraction of up to `decimals` digits, after normalizing separators. */
function parseFixed(input: string, decimals: number): { whole: string; fraction: string } | null {
  const text = toAsciiDigits(input.trim())
    .replace(/[\s,٬]/g, "") // thousands separators and spaces
    .replace("٫", "."); // Arabic decimal separator
  const match = new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimals}}))?$`).exec(text);
  if (!match) return null;
  return { whole: match[1], fraction: (match[2] ?? "").padEnd(decimals, "0") };
}

/** "1500", "1,500.5", "١٥٠٠٫٥٠" → piasters; null for anything else (negative, 3 decimals, text). */
export function parsePounds(input: string): number | null {
  const parts = parseFixed(input, 2);
  if (!parts) return null;
  const piasters = Number(parts.whole) * PIASTERS_PER_POUND + Number(parts.fraction);
  return Number.isSafeInteger(piasters) && piasters <= MAX_PIASTERS ? piasters : null;
}

/** "12.5" or "12.5%" → 1250 bps; null outside 0–100% or with more than 2 decimals. */
export function parsePercent(input: string): number | null {
  const parts = parseFixed(input.replace(/[%٪]\s*$/, ""), 2);
  if (!parts) return null;
  const bps = Number(parts.whole) * 100 + Number(parts.fraction);
  return bps <= MAX_BPS ? bps : null;
}

/**
 * `bps` of `amount`, rounded once to the nearest piaster, half up (BR-36, D-43). The only
 * rounding in the project (D-96): the pricing formula has no percentages; the minimum
 * deposit (phase 6) and refunds (phase 8) use this. Integer arithmetic only:
 * MAX_PIASTERS × MAX_BPS stays inside Number.MAX_SAFE_INTEGER.
 */
export function applyBps(amount: number, bps: number): number {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_PIASTERS) {
    throw new RangeError(`invalid amount: ${amount}`);
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_BPS) throw new RangeError(`invalid bps: ${bps}`);
  return Math.floor((amount * bps + MAX_BPS / 2) / MAX_BPS);
}

const groupFormat = new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 0 });
const arabicDigits = (ascii: string) => ascii.replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);

/** Integer `value` in hundredths → Arabic text; `fraction` gets 2 digits, or trims a trailing zero. */
function formatHundredths(value: number, trimFraction: boolean): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const whole = groupFormat.format(Math.trunc(abs / 100));
  const cents = abs % 100;
  if (cents === 0) return sign + whole;
  const fraction = String(cents).padStart(2, "0");
  return `${sign}${whole}٫${arabicDigits(trimFraction ? fraction.replace(/0$/, "") : fraction)}`;
}

/** 150050 → "١٬٥٠٠٫٥٠ ج.م", 150000 → "١٬٥٠٠ ج.م" (display only). */
export function formatPiasters(piasters: number): string {
  return `${formatHundredths(piasters, false)} ج.م`;
}

/** 1250 → "١٢٫٥٪" (display only). */
export function formatBps(bps: number): string {
  return `${formatHundredths(bps, true)}٪`;
}

/** Plain ASCII text for an input field: 150050 → "1500.50", 1250 bps → "12.5". */
export function piastersToInput(piasters: number): string {
  const whole = Math.trunc(piasters / PIASTERS_PER_POUND);
  const fraction = piasters % PIASTERS_PER_POUND;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, "0")}`;
}

export function bpsToInput(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const fraction = bps % 100;
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}`;
}
