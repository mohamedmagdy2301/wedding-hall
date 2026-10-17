import "server-only";
import { cookies } from "next/headers";

/** SEC-04: HttpOnly, Secure, SameSite=Lax; the value is the token, the database keeps its hash (D-61). */
export const SESSION_COOKIE = "wh_session";

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

/** Only from a Server Action: cookies cannot be set while rendering. */
export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}
