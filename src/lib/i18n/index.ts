import { ar } from "./ar";

export const t = ar;

/** Fills `{name}` placeholders of a catalog string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
