import { notFound, spikeAuthorized } from "../guard";

const encoder = new TextEncoder();

async function pbkdf2(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

/** A-03: one hash + one verify (what a password change followed by a login costs). */
export async function POST(request: Request) {
  if (!spikeAuthorized(request)) return notFound();
  const iterations = Number(new URL(request.url).searchParams.get("iterations") ?? "100000");
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 1_000_000) {
    return Response.json({ error: "iterations out of range" }, { status: 400 });
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  try {
    const stored = new Uint8Array(await pbkdf2("correct horse battery staple", salt, iterations));
    const candidate = new Uint8Array(await pbkdf2("correct horse battery staple", salt, iterations));
    const verified = stored.length === candidate.length && stored.every((b, i) => b === candidate[i]);
    return Response.json({ iterations, derivations: 2, verified });
  } catch (error) {
    return Response.json({ iterations, error: error instanceof Error ? error.message : "unknown" }, { status: 500 });
  }
}
