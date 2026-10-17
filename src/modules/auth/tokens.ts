/** Session tokens: 32 random bytes; only their SHA-256 is stored (D-61). WebCrypto works on Workers and Node. */

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateSessionToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cheap shape check before touching the database. */
export const looksLikeSessionToken = (value: string | undefined): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
