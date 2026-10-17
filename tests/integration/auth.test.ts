import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, sessions, users } from "@/db/schema";
import { addMs, MINUTE_MS } from "@/lib/time";
import { createPasswordHasher } from "@/modules/auth/password/hasher";
import { OWASP_DEFAULT } from "@/modules/auth/password/params";
import { loadArgon2ModuleFromDisk } from "@/modules/auth/password/wasm-node";
import { SESSION_TTL_MS } from "@/modules/auth/policy";
import { changePassword, login } from "@/modules/auth/service";
import { resolveSession } from "@/modules/auth/sessions";
import { authSpecs } from "@/server/specs/auth";
import { userSpecs } from "@/server/specs/users";
import { connectTestDb, truncateAll } from "./helpers/db";
import { callSpec, depsAt, META, OWNER, setUpVenueWithOwner, signIn } from "./helpers/fixtures";

describe("login, lockout and sessions", () => {
  const handle = connectTestDb();
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  const attempt = (loginText: string, password: string, now = new Date()) =>
    login(depsAt(handle, now), { login: loginText, password }, META).catch((e: unknown) => e);

  const lastAudit = async () =>
    (await handle.db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(1))[0];

  it("logs in with the normalized login and records IP and device (P1-04, P1-07)", async () => {
    await setUpVenueWithOwner(handle);
    const result = await login(depsAt(handle), { login: "  OWNER ", password: OWNER.password }, META);
    expect(result.mustChangePassword).toBe(false);
    expect(await resolveSession(handle.db, result.token, new Date())).not.toBeNull();

    const entry = await lastAudit();
    expect(entry.action).toBe("auth.login");
    expect(entry.meta).toMatchObject({ ip: META.ip, userAgent: META.userAgent, login: "owner" });
  });

  it("gives one generic error for a wrong password, an unknown login and a malformed login (SEC-03)", async () => {
    await setUpVenueWithOwner(handle);
    const errors = [await attempt("owner", "wrong-password"), await attempt("nobody", "x"), await attempt("??", "x")];
    for (const error of errors) expect(error).toMatchObject({ code: "UNAUTHENTICATED", messageKey: "loginFailed" });
  });

  it("never stores a password, and drops the typed login when it is not a valid format (P1-07, SEC-32)", async () => {
    await setUpVenueWithOwner(handle);
    await attempt("owner", "Secret-Typed-1");
    expect(JSON.stringify(await lastAudit())).not.toContain("Secret-Typed-1");

    await attempt("not a login!", "Secret-Typed-2");
    const entry = await lastAudit();
    expect(entry.action).toBe("auth.login_failed");
    expect(entry.meta).toMatchObject({ login: null, reason: "invalid_login_format" });
    expect(JSON.stringify(entry)).not.toContain("not a login!");
    expect(JSON.stringify(entry)).not.toContain("Secret-Typed-2");

    const all = JSON.stringify(await handle.db.select().from(auditLogs));
    expect(all).not.toContain(OWNER.password);
    expect(all).not.toContain("$argon2id$");
  });

  it("locks the account after 5 failures, even for the right password, and unlocks after 15 minutes (SEC-03)", async () => {
    await setUpVenueWithOwner(handle);
    const t0 = new Date("2026-10-17T10:00:00Z");
    for (let i = 0; i < 5; i++) await attempt("owner", "wrong-password", addMs(t0, i * 1000));

    const [locked] = await handle.db.select().from(users).where(eq(users.login, "owner"));
    expect(locked.lockedUntil?.toISOString()).toBe(addMs(t0, 4000 + 15 * MINUTE_MS).toISOString());
    expect(
      await handle.db.select({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.action, "auth.locked")),
    ).toHaveLength(1);

    const whileLocked = await attempt("owner", OWNER.password, addMs(t0, 10 * MINUTE_MS));
    expect(whileLocked).toMatchObject({ messageKey: "loginFailed" });

    const afterLock = await attempt("owner", OWNER.password, addMs(t0, 4000 + 15 * MINUTE_MS + 1));
    expect(afterLock).toMatchObject({ mustChangePassword: false });
    const [unlocked] = await handle.db.select().from(users).where(eq(users.login, "owner"));
    expect(unlocked.failedAttempts).toBe(0);
    expect(unlocked.lockedUntil).toBeNull();
  });

  it("resets the failure counter after a successful login (SEC-03)", async () => {
    await setUpVenueWithOwner(handle);
    for (let i = 0; i < 4; i++) await attempt("owner", "wrong-password");
    await attempt("owner", OWNER.password);
    for (let i = 0; i < 4; i++) await attempt("owner", "wrong-password");
    const [row] = await handle.db.select().from(users).where(eq(users.login, "owner"));
    expect(row.lockedUntil).toBeNull();
    expect(row.failedAttempts).toBe(4);
  });

  it("forces the temporary password to be changed before anything else (SEC-05)", async () => {
    const { owner, roleId } = await setUpVenueWithOwner(handle);
    await callSpec(handle, userSpecs.createUser, owner.token, {
      name: "استقبال",
      login: "01012345678",
      tempPassword: "temp-pass-1",
      roleIds: [roleId("استقبال/حجوزات")],
    });
    const fresh = await signIn(handle, "+20 101 234 5678", "temp-pass-1");
    expect(fresh.actor.mustChangePassword).toBe(true);

    const blocked = await callSpec(handle, authSpecs.logout, undefined, {});
    expect(blocked).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    const other = await callSpec(handle, userSpecs.createRole, fresh.token, { name: "x", permissionKeys: [] });
    expect(other).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: expect.stringContaining("كلمة المرور") },
    });

    const changed = await callSpec(handle, authSpecs.changePassword, fresh.token, {
      currentPassword: "temp-pass-1",
      newPassword: "new-pass-123",
      confirmPassword: "new-pass-123",
    });
    expect(changed.ok).toBe(true);
    const [row] = await handle.db.select().from(users).where(eq(users.login, "01012345678"));
    expect(row.mustChangePassword).toBe(false);
  });

  it("validates the new password (SEC-02) and the current one", async () => {
    const { owner } = await setUpVenueWithOwner(handle);
    const call = (input: object) => callSpec(handle, authSpecs.changePassword, owner.token, input);
    expect(
      await call({ currentPassword: OWNER.password, newPassword: "short", confirmPassword: "short" }),
    ).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR", fieldErrors: { newPassword: expect.any(String) } },
    });
    expect(
      await call({ currentPassword: OWNER.password, newPassword: "long-enough-1", confirmPassword: "different-1" }),
    ).toMatchObject({ ok: false, error: { fieldErrors: { confirmPassword: expect.any(String) } } });
    expect(
      await call({ currentPassword: "wrong", newPassword: "long-enough-1", confirmPassword: "long-enough-1" }),
    ).toMatchObject({ ok: false, error: { fieldErrors: { currentPassword: expect.any(String) } } });
    expect(
      await call({ currentPassword: OWNER.password, newPassword: OWNER.password, confirmPassword: OWNER.password }),
    ).toMatchObject({ ok: false, error: { fieldErrors: { newPassword: expect.any(String) } } });
  });

  it("ends every other session when the password changes (SEC-04)", async () => {
    const { owner } = await setUpVenueWithOwner(handle);
    const otherDevice = await signIn(handle, OWNER.login, OWNER.password);
    const { token } = await changePassword(
      depsAt(handle),
      owner.actor,
      { currentPassword: OWNER.password, newPassword: "brand-new-pass" },
      META,
    );
    expect(await resolveSession(handle.db, owner.token, new Date())).toBeNull();
    expect(await resolveSession(handle.db, otherDevice.token, new Date())).toBeNull();
    expect(await resolveSession(handle.db, token, new Date())).not.toBeNull();
  });

  it("ends the session at logout", async () => {
    const { owner } = await setUpVenueWithOwner(handle);
    expect((await callSpec(handle, authSpecs.logout, owner.token, {})).ok).toBe(true);
    expect(await resolveSession(handle.db, owner.token, new Date())).toBeNull();
    expect((await lastAudit()).action).toBe("auth.logout");
  });

  it("keeps a session for 7 days after the last use, sliding with use (SEC-04, T-17)", async () => {
    await setUpVenueWithOwner(handle);
    const t0 = new Date("2026-10-17T10:00:00Z");
    const { token } = await signIn(handle, OWNER.login, OWNER.password, t0);

    const day6 = addMs(t0, SESSION_TTL_MS - 24 * 60 * MINUTE_MS);
    expect(await resolveSession(handle.db, token, day6)).not.toBeNull();
    // Used on day 6, so still valid on day 12 …
    expect(await resolveSession(handle.db, token, addMs(day6, SESSION_TTL_MS - MINUTE_MS))).not.toBeNull();
    // … and expired 7 days after that last use.
    const lastUse = addMs(day6, SESSION_TTL_MS - MINUTE_MS);
    expect(await resolveSession(handle.db, token, addMs(lastUse, SESSION_TTL_MS + 1))).toBeNull();
  });

  it("stores only the token's hash (D-61)", async () => {
    const { owner } = await setUpVenueWithOwner(handle);
    const rows = await handle.db.select().from(sessions);
    expect(JSON.stringify(rows)).not.toContain(owner.token);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.tokenHash))).toBe(true);
  });

  it("rehashes the password at login when the parameters changed (P1-09)", async () => {
    await setUpVenueWithOwner(handle);
    const stronger = createPasswordHasher(loadArgon2ModuleFromDisk(), OWASP_DEFAULT);
    await login({ ...depsAt(handle), hasher: stronger }, { login: OWNER.login, password: OWNER.password }, META);

    const [row] = await handle.db.select().from(users).where(eq(users.login, "owner"));
    expect(row.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect((await lastAudit()).meta).toMatchObject({ passwordRehashed: true });
    // The new hash works, and with the same parameters there is no second rehash.
    await login({ ...depsAt(handle), hasher: stronger }, { login: OWNER.login, password: OWNER.password }, META);
    expect((await lastAudit()).meta).not.toHaveProperty("passwordRehashed");
  });
});
