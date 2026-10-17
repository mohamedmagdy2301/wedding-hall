import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auditLogs, roles, users, venues } from "@/db/schema";
import { listAudit, recordAudit } from "@/modules/audit/service";
import { setupVenue } from "@/modules/settings/setup";
import { DEFAULT_ROLES } from "@/modules/users-rbac/permissions";
import { connectTestDb, truncateAll } from "./helpers/db";
import { depsAt, setUpVenueWithOwner } from "./helpers/fixtures";
import { pgErrorCode } from "./helpers/pg-error";

describe("audit log", () => {
  const handle = connectTestDb();
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  it("rejects UPDATE and DELETE at the database level (SEC-42)", async () => {
    await setUpVenueWithOwner(handle);
    const [row] = await handle.db.select({ id: auditLogs.id }).from(auditLogs).limit(1);

    const update = await handle.db
      .update(auditLogs)
      .set({ action: "tampered" })
      .where(eq(auditLogs.id, row.id))
      .catch((e: unknown) => e);
    expect(pgErrorCode(update)).toBe("42501");

    const del = await handle.db
      .delete(auditLogs)
      .where(eq(auditLogs.id, row.id))
      .catch((e: unknown) => e);
    expect(pgErrorCode(del)).toBe("42501");

    const raw = await handle.db.execute(sql`DELETE FROM audit_logs`).catch((e: unknown) => e);
    expect(pgErrorCode(raw)).toBe("42501");
  });

  it("rolls back the audit row when its operation fails (SEC-41)", async () => {
    const { venueId } = await setUpVenueWithOwner(handle);
    const before = (await handle.db.select().from(auditLogs)).length;

    const error = await handle.db
      .transaction(async (tx) => {
        await recordAudit(tx, { venueId, actorId: null, action: "users.update", entityType: "user" });
        // The operation itself fails after its audit row was written.
        await tx.insert(users).values({ venueId, name: "x", login: "owner", passwordHash: "x" });
      })
      .catch((e: unknown) => e);

    expect(pgErrorCode(error)).toBe("23505");
    expect((await handle.db.select().from(auditLogs)).length).toBe(before);
  });

  it("setup-venue creates the venue, owner and default roles once, audited without the password (UF-01, P1-01)", async () => {
    const deps = depsAt(handle);
    const input = {
      venueName: "قاعة",
      ownerName: "المالك",
      ownerLogin: "Owner.Main",
      ownerTempPassword: "temp-pass-123",
    };
    await setupVenue(deps, input);

    const [venue] = await handle.db.select().from(venues);
    expect(venue).toMatchObject({
      name: "قاعة",
      bufferMinutes: 60,
      tentativeHoldHours: 48,
      minDepositType: "none",
      minDepositValue: 0,
      cancellationBasis: "deposit",
      postponeCreditMode: "refund",
    });
    const [owner] = await handle.db.select().from(users);
    expect(owner.login).toBe("owner.main");
    expect(owner.isOwner && owner.mustChangePassword && owner.isActive).toBe(true);
    const roleRows = await handle.db.select({ name: roles.name, isSystem: roles.isSystem }).from(roles);
    expect(roleRows.map((r) => r.name).sort()).toEqual(DEFAULT_ROLES.map((r) => r.name).sort());
    expect(roleRows.every((r) => r.isSystem)).toBe(true);

    const [entry] = await handle.db.select().from(auditLogs);
    expect(entry.action).toBe("venue.setup");
    expect(JSON.stringify(entry)).not.toContain("temp-pass-123");
    expect(JSON.stringify(entry)).not.toContain("$argon2id$");

    await expect(setupVenue(deps, { ...input, ownerLogin: "other" })).rejects.toMatchObject({
      messageKey: "venueAlreadySetUp",
    });
  });

  it("lists entries with actor names and filters by Cairo dates (S-16)", async () => {
    const { owner } = await setUpVenueWithOwner(handle);
    const all = await listAudit(handle.db, owner.actor, {});
    expect(all.total).toBeGreaterThanOrEqual(4);
    expect(all.rows.some((r) => r.action === "auth.login" && r.actorName === "المالك")).toBe(true);

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
    expect((await listAudit(handle.db, owner.actor, { from: today, to: today })).total).toBe(all.total);
    expect((await listAudit(handle.db, owner.actor, { to: "2000-01-01" })).total).toBe(0);
    expect((await listAudit(handle.db, owner.actor, { entityType: "venue" })).rows.map((r) => r.action)).toEqual([
      "venue.setup",
    ]);
  });
});
