/**
 * Login identifiers (P1-04): an Egyptian mobile normalized to 01XXXXXXXXX (D-52), or a
 * username of 3–32 characters from a-z 0-9 . _ - stored lower-case (case-insensitive).
 * Pure; shared by login, user management and the setup scripts.
 */

import { toAsciiDigits } from "@/lib/digits";

export type LoginId = { kind: "phone" | "username"; value: string };

/**
 * Egyptian mobile in any common spelling (spaces, dashes, Arabic digits, +20 / 0020 / 20
 * prefixes, or the 10 digits without the leading zero) → 01XXXXXXXXX.
 */
export function normalizeEgyptianMobile(input: string): string | null {
  const compact = toAsciiDigits(input.trim()).replace(/[\s\-().]/g, "");
  const national = compact.replace(/^(\+20|0020|20)(?=1)/, "0").replace(/^(?=1[0125]\d{8}$)/, "0");
  return /^01[0125]\d{8}$/.test(national) ? national : null;
}

const USERNAME = /^[a-z0-9._-]{3,32}$/;

/** Null when the text is neither a valid mobile nor a valid username. */
export function parseLoginId(input: string): LoginId | null {
  const phone = normalizeEgyptianMobile(input);
  if (phone) return { kind: "phone", value: phone };
  const username = input.trim().toLowerCase();
  return USERNAME.test(username) ? { kind: "username", value: username } : null;
}
