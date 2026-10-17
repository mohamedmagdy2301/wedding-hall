const adminUrl = process.env.TEST_DATABASE_ADMIN_URL || "postgres://postgres:postgres@localhost:54329/postgres";
const url = new URL(adminUrl);
url.pathname = "/wedding_hall_e2e";

export const E2E_DATABASE_URL = url.toString();
export const E2E_WS_PROXY = process.env.TEST_WS_PROXY ?? "localhost:54330";
export const E2E_VENUE_NAME = "قاعة الاختبار الشامل";

/**
 * Desktop and mobile projects share one database, so each gets its own owner (the
 * temporary-password flow can only run once per account) and its own staff logins.
 */
export const E2E_OWNERS = {
  desktop: { login: "owner", name: "مالك سطح المكتب" },
  mobile: { login: "owner.m", name: "مالك الموبايل" },
} as const;
export const E2E_TEMP_PASSWORD = "e2e-temp-pass-1";

/**
 * Phase 2 accounts per project, created ready to use (no temporary password) so the
 * settings journeys do not depend on the phase 1 spec having run first.
 */
export const E2E_P2_PASSWORD = "e2e-phase2-pass-1";
export const E2E_P2_USERS = {
  desktop: { owner: "p2.owner", manager: "p2.manager", reception: "p2.reception" },
  mobile: { owner: "p2.owner.m", manager: "p2.manager.m", reception: "p2.reception.m" },
} as const;
