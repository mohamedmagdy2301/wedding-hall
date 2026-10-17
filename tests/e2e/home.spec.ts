import { expect, test } from "@playwright/test";
import { E2E_VENUE_NAME } from "./env";

test("home page is Arabic RTL and reads the venue from the database", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("نظام إدارة قاعات الأفراح");
  await expect(page.getByTestId("venue-name")).toHaveText(E2E_VENUE_NAME);
});

test("Server Action reads from the database (A-02)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "افحص الآن" }).click();
  await expect(page.getByTestId("db-check-result")).toContainText("الاتصال يعمل");
});
