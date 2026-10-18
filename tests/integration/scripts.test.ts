import { spawnSync } from "node:child_process";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";
import { auditLogs, users } from "@/db/schema";
import { resolveSession } from "@/modules/auth/sessions";
import { grantOwnership } from "@/modules/users-rbac/users";
import { connectTestDb, testDatabaseUrl, truncateAll } from "./helpers/db";
import { addStaff, depsAt, setUpVenueWithOwner, signIn } from "./helpers/fixtures";

/** Runs a script as the product owner would, with answers piped to stdin (no TTY). */
function runScript(script: string, args: string[], input: string[]) {
  const wsProxy = inject("testWsProxy");
  const result = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", `scripts/${script}.ts`, ...args], {
    input: input.join("\n") + "\n",
    encoding: "utf8",
    env: {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      NEON_LOCAL_WSPROXY: wsProxy ?? "",
      APP_ENV: "test",
      PASSWORD_HASH_MEMORY_KIB: "1024",
      PASSWORD_HASH_ITERATIONS: "1",
    },
    timeout: 60_000,
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("setup and support scripts (UF-01, P1-03, P1-11)", () => {
  const handle = connectTestDb();
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  const lastAudit = async () =>
    (await handle.db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(1))[0];

  it("setup-venue reads the temporary password hidden, never prints it, and refuses a second run", async () => {
    const args = ["--venue-name", "قاعة السكريبت", "--owner-name", "المالك", "--owner-login", "01112345678"];
    const first = runScript("setup-venue", args, ["script-temp-pass", "script-temp-pass"]);
    expect(first.code, first.output).toBe(0);
    expect(first.output).not.toContain("script-temp-pass");

    const owner = await signIn(handle, "01112345678", "script-temp-pass");
    expect(owner.actor.isOwner && owner.actor.mustChangePassword).toBe(true);

    const second = runScript("setup-venue", args, ["another-pass-1", "another-pass-1"]);
    expect(second.code).toBe(1);
    expect(second.output).toContain("BUSINESS_RULE_VIOLATION");
  });

  it("setup-venue changes nothing when the two passwords differ", async () => {
    const result = runScript(
      "setup-venue",
      ["--venue-name", "x", "--owner-name", "y", "--owner-login", "owner"],
      ["first-pass-1", "second-pass-1"],
    );
    expect(result.code).toBe(1);
    expect(await handle.db.select().from(users)).toHaveLength(0);
  });

  it("remove-owner refuses to remove the last owner, then removes another owner with an audit entry", async () => {
    const { owner } = await setUpVenueWithOwner(handle);
    const last = runScript("remove-owner", ["--login", "owner", "--yes"], []);
    expect(last.code).toBe(1);
    expect(last.output).toContain("BR-100");

    const second = await addStaff(handle, owner.actor, "second", []);
    await grantOwnership(depsAt(handle), owner.actor, { userId: second.id });
    const removed = runScript("remove-owner", ["--login", "second"], ["yes"]);
    expect(removed.code, removed.output).toBe(0);

    const [row] = await handle.db.select().from(users).where(eq(users.login, "second"));
    expect(row.isOwner).toBe(false);
    expect(await lastAudit()).toMatchObject({
      action: "support.owner_removed",
      actorId: null,
      entityId: second.id,
      meta: { source: "support-script" },
    });
  });

  it("remove-owner does nothing without confirmation", async () => {
    await setUpVenueWithOwner(handle);
    const result = runScript("remove-owner", ["--login", "owner"], ["no"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Cancelled");
  });

  it("reset-owner-password sets a temporary password, forces a change, ends sessions, and logs no password", async () => {
    const { owner } = await setUpVenueWithOwner(handle);
    const result = runScript("reset-owner-password", ["--login", "owner", "--yes"], ["forgot-temp-1", "forgot-temp-1"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain("forgot-temp-1");

    expect(await resolveSession(handle.db, owner.token, new Date())).toBeNull();
    const again = await signIn(handle, "owner", "forgot-temp-1");
    expect(again.actor.mustChangePassword).toBe(true);
    const entry = (
      await handle.db.select().from(auditLogs).where(eq(auditLogs.action, "support.owner_password_reset"))
    )[0];
    expect(entry).toMatchObject({ actorId: null, meta: { source: "support-script" } });
    expect(JSON.stringify(await handle.db.select().from(auditLogs))).not.toContain("forgot-temp-1");
  });

  it("reset-owner-password refuses a non-owner (staff passwords are reset in the app)", async () => {
    const { owner } = await setUpVenueWithOwner(handle);
    await addStaff(handle, owner.actor, "staff", []);
    const result = runScript("reset-owner-password", ["--login", "staff", "--yes"], ["temp-pass-12", "temp-pass-12"]);
    expect(result.code).toBe(1);
  });
});
