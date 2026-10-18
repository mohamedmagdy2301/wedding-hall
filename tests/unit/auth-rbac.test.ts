import { describe, expect, it } from "vitest";
import { normalizeEgyptianMobile, parseLoginId } from "@/modules/auth/login-id";
import {
  afterFailedAttempt,
  isLocked,
  LOCKOUT_MS,
  MAX_FAILED_ATTEMPTS,
  passwordPolicyError,
} from "@/modules/auth/policy";
import {
  DEFAULT_ROLES,
  effectivePermissions,
  PERMISSION_KEYS,
  ungrantableKeys,
  type PermissionKey,
} from "@/modules/users-rbac/permissions";

describe("login identifiers (P1-04, D-52)", () => {
  it.each([
    ["01012345678", "01012345678"],
    ["010 1234 5678", "01012345678"],
    ["0101-234-5678", "01012345678"],
    ["+201012345678", "01012345678"],
    ["00201112345678", "01112345678"],
    ["201212345678", "01212345678"],
    ["1512345678", "01512345678"],
    ["٠١٠١٢٣٤٥٦٧٨", "01012345678"],
  ])("normalizes the mobile %s", (input, expected) => {
    expect(normalizeEgyptianMobile(input)).toBe(expected);
    expect(parseLoginId(input)).toEqual({ kind: "phone", value: expected });
  });

  it.each(["01312345678", "0101234567", "021234567890"])("rejects %s as a mobile", (input) => {
    expect(normalizeEgyptianMobile(input)).toBeNull();
  });

  it("treats usernames case-insensitively and stores them lower-case", () => {
    expect(parseLoginId("  Ahmed.Ali_2 ")).toEqual({ kind: "username", value: "ahmed.ali_2" });
    expect(parseLoginId("abc")).toEqual({ kind: "username", value: "abc" });
    expect(parseLoginId("a".repeat(32))?.kind).toBe("username");
  });

  it.each(["ab", "a".repeat(33), "أحمد", "ahmed ali", "ahmed@x", ""])("rejects the login %j", (input) => {
    expect(parseLoginId(input)).toBeNull();
  });
});

describe("password policy and lockout (SEC-02, SEC-03)", () => {
  it("requires at least 8 characters", () => {
    expect(passwordPolicyError("1234567")).toBe("passwordTooShort");
    expect(passwordPolicyError("12345678")).toBeNull();
    expect(passwordPolicyError("x".repeat(129))).toBe("passwordTooLong");
  });

  it("locks for 15 minutes on the 5th consecutive failure and restarts the count", () => {
    const now = new Date("2026-10-17T10:00:00Z");
    let state = { failedAttempts: 0, lockedUntil: null as Date | null };
    for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
      state = afterFailedAttempt(state.failedAttempts, now);
      expect(state).toEqual({ failedAttempts: i, lockedUntil: null });
    }
    state = afterFailedAttempt(state.failedAttempts, now);
    expect(state.failedAttempts).toBe(0);
    expect(state.lockedUntil?.getTime()).toBe(now.getTime() + LOCKOUT_MS);
    expect(isLocked(state.lockedUntil, new Date(now.getTime() + LOCKOUT_MS - 1))).toBe(true);
    expect(isLocked(state.lockedUntil, new Date(now.getTime() + LOCKOUT_MS))).toBe(false);
    expect(isLocked(null, now)).toBe(false);
  });
});

describe("permissions (ROLES_PERMISSIONS, BR-102)", () => {
  it("the owner has every permission without roles", () => {
    expect(effectivePermissions(true, []).size).toBe(PERMISSION_KEYS.length);
  });

  it("a user's permissions are the union of their roles, ignoring unknown keys", () => {
    const perms = effectivePermissions(false, ["bookings.view", "payments.record", "bookings.view", "made.up"]);
    expect([...perms].sort()).toEqual(["bookings.view", "payments.record"]);
  });

  it("default roles match the matrix: settings.manage, users.manage and payments.backdate belong to the owner (D-118)", () => {
    const byName = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.name, new Set<PermissionKey>(r.permissions)]));
    expect(byName["مدير"].size).toBe(PERMISSION_KEYS.length - 3);
    for (const role of DEFAULT_ROLES) {
      expect(role.permissions).not.toContain("settings.manage");
      expect(role.permissions).not.toContain("users.manage");
      expect(role.permissions).not.toContain("payments.backdate");
    }
    expect(byName["استقبال/حجوزات"].has("bookings.cancel")).toBe(false);
    expect(byName["محاسب"].has("payments.refund")).toBe(true);
    expect(byName["محاسب"].has("bookings.create")).toBe(false);
  });

  it("lists what a non-owner cannot grant (BR-102)", () => {
    const granter = effectivePermissions(false, ["bookings.view", "users.manage"]);
    expect(ungrantableKeys(granter, ["bookings.view", "payments.void", "payments.void"])).toEqual(["payments.void"]);
    expect(ungrantableKeys(granter, ["bookings.view"])).toEqual([]);
  });
});
