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
