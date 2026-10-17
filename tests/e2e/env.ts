const adminUrl = process.env.TEST_DATABASE_ADMIN_URL || "postgres://postgres:postgres@localhost:54329/postgres";
const url = new URL(adminUrl);
url.pathname = "/wedding_hall_e2e";

export const E2E_DATABASE_URL = url.toString();
export const E2E_WS_PROXY = process.env.TEST_WS_PROXY ?? "localhost:54330";
export const E2E_VENUE_NAME = "قاعة الاختبار الشامل";
