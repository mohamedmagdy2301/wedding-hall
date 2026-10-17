import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { E2E_P2_PASSWORD, E2E_P2_USERS } from "./env";

/**
 * Phase 2 journeys (PHASE2_PLAN E2E): the guided setup reflects what is missing and fills
 * up as the owner configures (UF-02, S-14); settings screens per permission (D-66);
 * seasons never overlap (BR-31); BR-02 on slot times.
 *
 * Both projects share one venue, so the full guided flow (which asserts the initial
 * "missing" states) runs on desktop only; the mobile project touches only seasons, which
 * the desktop flow does not assert, and uses its own dates.
 */
test.describe.configure({ mode: "serial" });

const usersOf = (info: TestInfo) => E2E_P2_USERS[info.project.name as keyof typeof E2E_P2_USERS];

async function signIn(page: Page, login: string) {
  await page.goto("/login");
  await page.getByLabel("رقم الموبايل أو اسم المستخدم").fill(login);
  await page.getByLabel("كلمة المرور").fill(E2E_P2_PASSWORD);
  await page.getByRole("button", { name: "دخول" }).click();
  await expect(page).toHaveURL(/\/$/);
}

const step = (page: Page, key: string) => page.getByTestId(`setup-step-${key}`);

test("the owner's guided setup shows what is missing and fills up as they configure (UF-02)", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "One venue per database: the full flow runs once.");
  await signIn(page, usersOf(info).owner);

  // The home card leads to the checklist (S-14).
  await expect(page.getByTestId("setup-card")).toBeVisible();
  await page.getByRole("link", { name: "افتح قائمة الإعداد" }).click();
  await expect(page).toHaveURL(/\/setup$/);
  for (const key of ["venue", "spaces", "eventTypes", "paymentMethods", "policies"]) {
    await expect(step(page, key)).toHaveAttribute("data-status", "missing");
  }
  await expect(step(page, "timing")).toHaveAttribute("data-status", "done");
  await expect(step(page, "timing")).toContainText("60");
  await expect(step(page, "services")).toHaveAttribute("data-status", "missing");
  await expect(step(page, "packages")).toHaveAttribute("data-status", "missing");

  // Venue data.
  await step(page, "venue").getByRole("link").click();
  await expect(page).toHaveURL(/\/settings\/venue$/);
  await page.getByLabel("التليفون").fill("0221234567");
  await page.getByLabel("العنوان").fill("مدينة نصر، القاهرة");
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByTestId("saved-note")).toHaveText("تم الحفظ.");

  // A space: slots that break BR-02 are flagged while typing and refused by the server.
  await page.getByRole("link", { name: "الأماكن والفترات" }).click();
  await page.getByRole("button", { name: "إضافة مكان" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("الاسم").fill("القاعة الكبرى");
  await dialog.getByTestId("day-start").fill("12:00");
  await dialog.getByTestId("day-end").fill("17:00");
  await dialog.getByTestId("evening-start").fill("17:30");
  await dialog.getByTestId("evening-end").fill("23:00");
  await expect(dialog.getByTestId("slots-preview")).toContainText("BR-02");
  await dialog.getByRole("button", { name: "حفظ" }).click();
  await expect(dialog.getByText("الفترة النهارية + الوقت الفاصل").first()).toBeVisible();
  await dialog.getByTestId("evening-start").fill("18:00");
  await dialog.getByTestId("evening-end").fill("01:00");
  await expect(dialog.getByTestId("slots-preview")).toContainText("تنتهي بعد منتصف الليل");
  await dialog.getByRole("button", { name: "حفظ" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("space-row").filter({ hasText: "القاعة الكبرى" })).toBeVisible();

  // Cancellation tiers (mandatory, D-67) with the live example (BR-71).
  await page.getByRole("link", { name: "السياسات" }).click();
  // D-74: saving the ready "0 days: 0%" tier alone asks for an explicit confirmation.
  await page.getByRole("button", { name: "حفظ" }).click();
  const noRefund = page.getByRole("dialog");
  await expect(noRefund).toContainText("العميل مش هيسترد أي مبلغ عند الإلغاء في أي وقت. متأكد؟");
  await noRefund.getByRole("button", { name: "إلغاء" }).click();
  await expect(noRefund).toBeHidden();
  await expect(page.getByTestId("saved-note")).toHaveText("");
  await page.getByRole("button", { name: "حفظ" }).click();
  await noRefund.getByRole("button", { name: "متأكد، احفظ" }).click();
  await expect(noRefund).toBeHidden();
  await expect(page.getByTestId("saved-note")).toHaveText("تم الحفظ.");
  // With a tier above 0% there is nothing to confirm.
  await page.getByRole("button", { name: "إضافة شريحة" }).click();
  await page.getByTestId("tier-1").getByLabel("قبل الحفلة بـ (يوم) أو أكثر").fill("30");
  await page.getByTestId("tier-1").getByLabel("يُرد (%)").fill("50");
  await expect(page.getByTestId("tier-preview")).toContainText("٥٠٪");
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  // Shown with the most days first.
  await expect(page.getByTestId("tier-0").getByLabel("قبل الحفلة بـ (يوم) أو أكثر")).toHaveValue("30");
  await expect(page.getByTestId("tier-0").getByLabel("يُرد (%)")).toHaveValue("50");

  // Event types from the suggested list, and one payment method by hand.
  await page.getByRole("link", { name: "أنواع المناسبات" }).click();
  await page.getByRole("button", { name: "أضف القائمة المقترحة" }).click();
  await expect(page.getByTestId("list-row").filter({ hasText: "فرح" }).first()).toBeVisible();
  await expect(page.getByTestId("list-row")).toHaveCount(6);
  await page.getByRole("link", { name: "طرق الدفع" }).click();
  await page.getByRole("button", { name: "إضافة طريقة دفع" }).click();
  await page.getByRole("dialog").getByLabel("الاسم").fill("نقدي");
  await page.getByRole("dialog").getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByTestId("list-row").filter({ hasText: "نقدي" })).toBeVisible();

  // The checklist reflects it; services and packages are still missing, so the card stays (phase 3 spec).
  await page.goto("/setup");
  for (const key of ["venue", "spaces", "eventTypes", "paymentMethods", "policies"]) {
    await expect(step(page, key)).toHaveAttribute("data-status", "done");
  }
  await page.goto("/");
  await expect(page.getByTestId("setup-card")).toBeVisible();
});

test("seasons never overlap: the clash is named before saving and refused by the server (BR-31)", async ({
  page,
}, info) => {
  const year = info.project.name === "desktop" ? 2027 : 2028;
  await signIn(page, usersOf(info).owner);
  await page.goto("/settings/seasons");
  const add = async (name: string, start: string, end: string) => {
    await page.getByRole("button", { name: "إضافة موسم" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("الاسم").fill(name);
    await dialog.getByLabel("من تاريخ").fill(start);
    await dialog.getByLabel("إلى تاريخ").fill(end);
    return dialog;
  };
  const summer = await add(`الصيف ${year}`, `${year}-06-01`, `${year}-08-31`);
  await summer.getByRole("button", { name: "حفظ" }).click();
  await expect(summer).toBeHidden();

  const clash = await add(`العيد ${year}`, `${year}-08-31`, `${year}-09-05`);
  await expect(clash.getByTestId("season-clash")).toContainText(`الصيف ${year}`);
  await clash.getByRole("button", { name: "حفظ" }).click();
  await expect(clash.getByText("يتداخل مع موسم نشط آخر")).toBeVisible();
  await clash.getByLabel("من تاريخ").fill(`${year}-09-01`);
  await expect(clash.getByTestId("season-clash")).toBeHidden();
  await clash.getByRole("button", { name: "حفظ" }).click();
  await expect(clash).toBeHidden();
  await expect(page.getByTestId("season-row").filter({ hasText: String(year) })).toHaveCount(2);
});

test("the manager opens spaces and seasons but not the policies (D-66)", async ({ page }, info) => {
  await signIn(page, usersOf(info).manager);
  await expect(page.getByTestId("setup-card")).toBeHidden();
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/spaces$/);
  const tabs = page.getByRole("navigation", { name: "الإعدادات" });
  await expect(tabs.getByRole("link", { name: "المواسم" })).toBeVisible();
  await expect(tabs.getByRole("link", { name: "السياسات" })).toHaveCount(0);
  await page.goto("/settings/policies");
  await expect(page).toHaveURL(/\/forbidden$/);
  await page.goto("/setup");
  await expect(page).toHaveURL(/\/forbidden$/);
});

test("the receptionist cannot open any settings screen by direct link", async ({ page }, info) => {
  await signIn(page, usersOf(info).reception);
  await expect(page.getByRole("link", { name: "الإعدادات" })).toHaveCount(0);
  for (const path of ["/settings", "/settings/venue", "/settings/spaces", "/settings/seasons", "/settings/policies"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/forbidden$/);
  }
});
