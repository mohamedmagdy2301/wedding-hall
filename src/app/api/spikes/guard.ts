import "server-only";

/**
 * Spike endpoints (phase 1 step 1.0) exist only while SPIKE_TOKEN is set as a Worker secret,
 * and require it in the `x-spike-token` header. Removed after the hashing decision (D-58).
 */
export function spikeAuthorized(request: Request): boolean {
  // Trimmed: secrets piped through a shell may carry a trailing newline.
  const token = process.env.SPIKE_TOKEN?.trim();
  if (!token || token.length < 32) return false;
  return request.headers.get("x-spike-token") === token;
}

export const notFound = () => new Response("Not Found", { status: 404 });
