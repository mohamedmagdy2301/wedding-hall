import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { users } from "@/db/schema";
import { listAudit } from "@/modules/audit/service";
import { resolveSession } from "@/modules/auth/sessions";
import { listRoles } from "@/modules/users-rbac/roles";
import { listUsers } from "@/modules/users-rbac/users";
import type { ProtectedSpec } from "@/server/specs/define";
import { userSpecs } from "@/server/specs/users";
import { connectTestDb, truncateAll } from "./helpers/db";
import { addStaff, auditActions, callSpec, setUpVenueWithOwner, signIn } from "./helpers/fixtures";

describe("users, roles and owners", () => {
  const handle = connectTestDb();
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  /** Owner + a second owner + a non-owner manager holding users.manage through a custom role. */
  async function scenario() {
    const base = await setUpVenueWithOwner(handle);
    const { owner, roleId } = base;
    const managerRole = await callSpec(handle, userSpecs.createRole, owner.token, {
      name: "مدير الموظفين",
      permissionKeys: ["users.manage", "bookings.view", "bookings.create"],
    });
    if (!managerRole.ok) throw new Error(managerRole.error.message);
    const manager = await addStaff(handle, owner.actor, "manager", [managerRole.data.id]);
    const reception = await addStaff(handle, owner.actor, "reception", [roleId("استقبال/حجوزات")]);
    const second = await addStaff(handle, owner.actor, "second.owner", []);
    expect((await callSpec(handle, userSpecs.grantOwnership, owner.token, { userId: second.id })).ok).toBe(true);
    return {
      ...base,
      managerRoleId: managerRole.data.id,
      manager,
      reception,
      secondOwner: await signIn(handle, "second.owner", second.password),
      secondId: second.id,
    };
  }

  const ownerRow = async (login: string) => (await handle.db.select().from(users).where(eq(users.login, login)))[0];

  describe("BR-100 / P1-11: owners", () => {
    it("an owner cannot be deactivated by anyone, including another owner or themselves", async () => {
      const s = await scenario();
      for (const token of [s.owner.token, s.secondOwner.token]) {
        const result = await callSpec(handle, userSpecs.setUserActive, token, { userId: s.ownerId, active: false });
        expect(result).toMatchObject({ ok: false, error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-100" } });
      }
      expect((await ownerRow("owner")).isActive).toBe(true);
    });

    it("an owner cannot remove another owner's ownership: the app has no such operation (P1-11)", async () => {
      const s = await scenario();
      // The only in-app way to drop ownership is renouncing your own.
      expect(
        Object.keys(userSpecs)
          .filter((k) => /owner/i.test(k))
          .sort(),
      ).toEqual(["grantOwnership", "renounceOwnership"]);
      // Editing another owner never touches is_owner, even with extra fields.
      await callSpec(handle, userSpecs.updateUser, s.owner.token, {
        userId: s.secondId,
        name: "اسم جديد",
        login: "second.owner",
        roleIds: [],
        isOwner: false,
      });
      expect((await ownerRow("second.owner")).isOwner).toBe(true);
    });

    it("an owner cannot reset another owner's password or change their login (P1-11)", async () => {
      const s = await scenario();
      const reset = await callSpec(handle, userSpecs.resetUserPassword, s.owner.token, {
        userId: s.secondId,
        tempPassword: "takeover-123",
      });
      expect(reset).toMatchObject({ ok: false, error: { rule: "BR-100" } });
      const rename = await callSpec(handle, userSpecs.updateUser, s.owner.token, {
        userId: s.secondId,
        name: "مالك ثان",
        login: "taken.over",
        roleIds: [],
      });
      expect(rename).toMatchObject({ ok: false, error: { rule: "BR-100" } });
      expect((await ownerRow("second.owner")).login).toBe("second.owner");
      // Each owner changes their own login.
      const own = await callSpec(handle, userSpecs.updateUser, s.secondOwner.token, {
        userId: s.secondId,
        name: "مالك ثان",
        login: "second",
        roleIds: [],
      });
      expect(own.ok).toBe(true);
    });

    it("an owner renounces their own ownership only while another active owner remains", async () => {
      const s = await scenario();
      expect((await callSpec(handle, userSpecs.renounceOwnership, s.secondOwner.token, {})).ok).toBe(true);
      expect((await ownerRow("second.owner")).isOwner).toBe(false);
      const last = await callSpec(handle, userSpecs.renounceOwnership, s.owner.token, {});
      expect(last).toMatchObject({ ok: false, error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-100" } });
      expect((await ownerRow("owner")).isOwner).toBe(true);
      expect(await auditActions(handle)).toEqual(
        expect.arrayContaining(["users.owner_granted", "users.owner_renounced"]),
      );
    });

    it("two owners renouncing at the same time leave one owner", async () => {
      const s = await scenario();
      const results = await Promise.all([
        callSpec(handle, userSpecs.renounceOwnership, s.owner.token, {}),
        callSpec(handle, userSpecs.renounceOwnership, s.secondOwner.token, {}),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await handle.db.select().from(users).where(eq(users.isOwner, true))).length).toBe(1);
    });

    it("only owners grant ownership", async () => {
      const s = await scenario();
      const byManager = await callSpec(handle, userSpecs.grantOwnership, s.manager.token, { userId: s.reception.id });
      expect(byManager).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect((await ownerRow("reception")).isOwner).toBe(false);
    });
  });

  describe("BR-101: deactivation", () => {
    it("a deactivated user cannot log in, and an open session stops fetching any data at once", async () => {
      const s = await scenario();
      const before = await callSpec(handle, userSpecs.createRole, s.manager.token, { name: "دور", permissionKeys: [] });
      expect(before.ok).toBe(true);

      await callSpec(handle, userSpecs.setUserActive, s.owner.token, { userId: s.manager.id, active: false });

      expect(await resolveSession(handle.db, s.manager.token, new Date())).toBeNull();
      const after = await callSpec(handle, userSpecs.createRole, s.manager.token, {
        name: "دور 2",
        permissionKeys: [],
      });
      expect(after).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
      await expect(signIn(handle, "manager", s.manager.password)).rejects.toMatchObject({ messageKey: "loginFailed" });
      // Reactivation allows login again (the old session stays ended).
      await callSpec(handle, userSpecs.setUserActive, s.owner.token, { userId: s.manager.id, active: true });
      expect(await resolveSession(handle.db, s.manager.token, new Date())).toBeNull();
      await expect(signIn(handle, "manager", s.manager.password)).resolves.toBeTruthy();
    });
  });

  describe("BR-102: non-owners with users.manage", () => {
    it("cannot edit, deactivate or reset an owner's account", async () => {
      const s = await scenario();
      const calls = [
        callSpec(handle, userSpecs.updateUser, s.manager.token, {
          userId: s.ownerId,
          name: "x",
          login: "owner",
          roleIds: [],
        }),
        callSpec(handle, userSpecs.setUserActive, s.manager.token, { userId: s.ownerId, active: false }),
        callSpec(handle, userSpecs.resetUserPassword, s.manager.token, {
          userId: s.ownerId,
          tempPassword: "takeover-1",
        }),
      ];
      for (const result of await Promise.all(calls)) {
        expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN", rule: "BR-102" } });
      }
    });

    it("grant only permissions they hold, in roles and in role assignments", async () => {
      const s = await scenario();
      const tooMuch = await callSpec(handle, userSpecs.createRole, s.manager.token, {
        name: "صلاحيات أكثر",
        permissionKeys: ["bookings.view", "payments.void"],
      });
      expect(tooMuch).toMatchObject({ ok: false, error: { code: "FORBIDDEN", rule: "BR-102" } });

      const fine = await callSpec(handle, userSpecs.createRole, s.manager.token, {
        name: "عرض فقط",
        permissionKeys: ["bookings.view"],
      });
      expect(fine.ok).toBe(true);

      const addToRole = await callSpec(handle, userSpecs.updateRole, s.manager.token, {
        roleId: s.managerRoleId,
        name: "مدير الموظفين",
        permissionKeys: ["users.manage", "bookings.view", "bookings.create", "audit.view"],
      });
      expect(addToRole).toMatchObject({ ok: false, error: { rule: "BR-102" } });

      // The reception role has permissions the manager lacks (e.g. payments.record).
      const assign = await callSpec(handle, userSpecs.createUser, s.manager.token, {
        name: "جديد",
        login: "new.staff",
        tempPassword: "temp-pass-1",
        roleIds: [s.roleId("استقبال/حجوزات")],
      });
      expect(assign).toMatchObject({ ok: false, error: { rule: "BR-102" } });
      // Removing permissions is not granting.
      const remove = await callSpec(handle, userSpecs.updateRole, s.manager.token, {
        roleId: s.roleId("استقبال/حجوزات"),
        name: "استقبال/حجوزات",
        permissionKeys: ["bookings.view"],
      });
      expect(remove.ok).toBe(true);
    });
  });

  describe("roles (P1-06) and staff (UF-11)", () => {
    it("a role in use cannot be deleted; an unused one can, and default roles are editable", async () => {
      const s = await scenario();
      const inUse = await callSpec(handle, userSpecs.deleteRole, s.owner.token, { roleId: s.roleId("استقبال/حجوزات") });
      expect(inUse).toMatchObject({ ok: false, error: { code: "BUSINESS_RULE_VIOLATION" } });
      const rename = await callSpec(handle, userSpecs.updateRole, s.owner.token, {
        roleId: s.roleId("محاسب"),
        name: "محاسب رئيسي",
        permissionKeys: ["bookings.view"],
      });
      expect(rename.ok).toBe(true);
      expect((await callSpec(handle, userSpecs.deleteRole, s.owner.token, { roleId: s.roleId("محاسب") })).ok).toBe(
        true,
      );
      expect((await listRoles(handle.db, s.owner.actor)).map((r) => r.name)).not.toContain("محاسب رئيسي");
    });

    it("rejects duplicate logins and role names with field errors", async () => {
      const s = await scenario();
      const dupLogin = await callSpec(handle, userSpecs.createUser, s.owner.token, {
        name: "مكرر",
        login: "RECEPTION",
        tempPassword: "temp-pass-1",
        roleIds: [],
      });
      expect(dupLogin).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR", fieldErrors: { login: expect.any(String) } },
      });
      const dupRole = await callSpec(handle, userSpecs.createRole, s.owner.token, {
        name: "محاسب",
        permissionKeys: [],
      });
      expect(dupRole).toMatchObject({ ok: false, error: { fieldErrors: { name: expect.any(String) } } });
    });

    it("resetting a staff password forces a change, unlocks and ends sessions", async () => {
      const s = await scenario();
      await callSpec(handle, userSpecs.resetUserPassword, s.owner.token, {
        userId: s.reception.id,
        tempPassword: "reset-pass-1",
      });
      expect(await resolveSession(handle.db, s.reception.token, new Date())).toBeNull();
      const again = await signIn(handle, "reception", "reset-pass-1");
      expect(again.actor.mustChangePassword).toBe(true);
    });

    it("permissions are the union of roles, applied immediately (ROLES_PERMISSIONS)", async () => {
      const s = await scenario();
      expect([...s.reception.actor.permissions]).not.toContain("users.manage");
      await callSpec(handle, userSpecs.updateUser, s.owner.token, {
        userId: s.reception.id,
        name: "موظف reception",
        login: "reception",
        roleIds: [s.roleId("استقبال/حجوزات"), s.managerRoleId],
      });
      const now = await resolveSession(handle.db, s.reception.token, new Date());
      expect(now?.permissions.has("users.manage")).toBe(true);
      expect(now?.permissions.has("payments.record")).toBe(true);
    });

    it("every user and role operation is audited with before/after and no password", async () => {
      const s = await scenario();
      await callSpec(handle, userSpecs.resetUserPassword, s.owner.token, {
        userId: s.reception.id,
        tempPassword: "reset-pass-1",
      });
      const actions = await auditActions(handle);
      expect(actions).toEqual(
        expect.arrayContaining(["users.create", "roles.create", "users.owner_granted", "users.password_reset"]),
      );
      const dump = JSON.stringify((await listAudit(handle.db, s.owner.actor, {})).rows);
      expect(dump).not.toContain("reset-pass-1");
      expect(dump).not.toContain("$argon2id$");
    });
  });

  describe("SEC-11: every sensitive operation of this phase refuses a direct call without its permission", () => {
    const sampleInputs = (s: Awaited<ReturnType<typeof scenario>>): Record<keyof typeof userSpecs, unknown> => ({
      createUser: { name: "x", login: "xx.yy", tempPassword: "temp-pass-1", roleIds: [] },
      updateUser: { userId: s.reception.id, name: "x", login: "reception", roleIds: [] },
      setUserActive: { userId: s.reception.id, active: false },
      resetUserPassword: { userId: s.reception.id, tempPassword: "temp-pass-1" },
      grantOwnership: { userId: s.reception.id },
      renounceOwnership: {},
      createRole: { name: "دور جديد", permissionKeys: [] },
      updateRole: { roleId: s.managerRoleId, name: "x", permissionKeys: [] },
      deleteRole: { roleId: s.managerRoleId },
    });

    it.each(Object.keys(userSpecs) as Array<keyof typeof userSpecs>)("%s", async (name) => {
      const s = await scenario();
      // Type-erased: each spec has its own input type; the sample inputs above match them.
      const spec = userSpecs[name] as unknown as ProtectedSpec<z.ZodType, unknown>;
      // Reception lacks users.manage; the manager has users.manage but is not an owner.
      const caller = spec.requires === "owner" ? s.manager : s.reception;
      const result = await callSpec(handle, spec, caller.token, sampleInputs(s)[name]);
      expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

      const anonymous = await callSpec(handle, spec, undefined, sampleInputs(s)[name]);
      expect(anonymous).toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
    });

    it("listing staff, roles and the audit log needs users.manage / audit.view", async () => {
      const s = await scenario();
      await expect(listUsers(handle.db, s.reception.actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(listRoles(handle.db, s.reception.actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(listAudit(handle.db, s.manager.actor, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });
});
