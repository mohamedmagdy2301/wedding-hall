import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { E2E_P2_PASSWORD, E2E_P2_USERS } from "./env";

/**
 * Phase 3 journeys (PHASE3_PLAN E2E): the manager builds the catalog — services, then a
 * package with prices and included services; an active package needs a regular price
 * (BR-30, the phase acceptance); a stale package page cannot overwrite another save
 * (D-81); the guided setup reflects the catalog (UF-02); the receptionist is kept out.
 *
 * Each project uses its own names, since both share one venue.
 */
test.describe.configure({ mode: "serial" });

const usersOf = (info: TestInfo) => E2E_P2_USERS[info.project.name as keyof typeof E2E_P2_USERS];
const suffix = (info: TestInfo) => (info.project.name === "desktop" ? "د" : "م");

async function signIn(page: Page, login: string) {
  await page.goto("/login");
  await page.getByLabel("رقم الموبايل أو اسم المستخدم").fill(login);
  await page.getByLabel("كلمة المرور").fill(E2E_P2_PASSWORD);
  await page.getByRole("button", { name: "دخول" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function addService(page: Page, name: string, type: string, price: string, externalFee?: string) {
  await page.getByRole("button", { name: "إضافة خدمة" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("الاسم").fill(name);
  await dialog.getByTestId("service-pricing-type").click();
  await page.getByRole("option", { name: type }).click();
  await dialog.getByLabel("السعر (جنيه)").fill(price);
  if (externalFee !== undefined) {
    await dialog.getByLabel("يُسمح بمتعهد خارجي").check();
    await dialog.getByLabel("رسوم دخول المتعهد الخارجي (جنيه)").fill(externalFee);
  }
  await dialog.getByRole("button", { name: "حفظ" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("service-row").filter({ hasText: name })).toBeVisible();
}

test("the manager builds services and a priced package; no active package without a regular price (BR-30)", async ({
  page,
}, info) => {
  const s = suffix(info);
  const space = `قاعة الكتالوج ${s}`;
  const dj = `دي جي ${s}`;
  const photos = `تصوير ${s}`;
  const silver = `الفضي ${s}`;
  await signIn(page, usersOf(info).manager);

  // A space of its own (default slots), with a capacity for the warning below.
  await page.goto("/settings/spaces");
  await page.getByRole("button", { name: "إضافة مكان" }).click();
  const spaceDialog = page.getByRole("dialog");
  await spaceDialog.getByLabel("الاسم").fill(space);
  await spaceDialog.getByLabel("السعة القصوى (اختياري)").fill("500");
  await spaceDialog.getByRole("button", { name: "حفظ" }).click();
  await expect(spaceDialog).toBeHidden();

  // Services: the catalog tabs are there for catalog.manage (D-66).
  const tabs = page.getByRole("navigation", { name: "الإعدادات" });
  await tabs.getByRole("link", { name: "الخدمات" }).click();
  await expect(page).toHaveURL(/\/settings\/services$/);
  await addService(page, dj, "سعر ثابت", "3000", "500");
  await addService(page, photos, "بالعدد", "1500");
  await expect(page.getByTestId("service-row").filter({ hasText: dj })).toContainText("٥٠٠");

  // A new package on its own page (P3-14).
  await tabs.getByRole("link", { name: "الباكيجات" }).click();
  await page.getByRole("link", { name: "باكيج جديد" }).click();
  await expect(page).toHaveURL(/\/settings\/packages\/new$/);
  await expect(tabs.getByRole("link", { name: "الباكيجات" })).toHaveAttribute("aria-current", "page");
  await page.getByTestId("package-space").click();
  await page.getByRole("option", { name: space }).click();
  await page.getByLabel("الاسم", { exact: true }).fill(silver);
  await page.getByLabel("عدد المعازيم الأساسي").fill("600");
  await expect(page.getByTestId("capacity-warning")).toContainText("500");
  await page.getByLabel("عدد المعازيم الأساسي").fill("200");
  await expect(page.getByTestId("capacity-warning")).toBeHidden();
  await page.getByLabel("سعر الفرد الزيادة (جنيه)").fill("150");
  await expect(page.getByTestId("price-note")).toHaveText(
    "تغيير الأسعار مش بيأثر على الحجوزات المؤكدة، لأن سعرها متثبت وقت التأكيد",
  );

  // Active without a regular price: flagged while typing and refused by the server (BR-30).
  await expect(page.getByTestId("prices-error")).toContainText("الباكيج النشط لازم يكون له سعر عادي");
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByTestId("prices-error")).toContainText("BR-30");
  await expect(page).toHaveURL(/\/settings\/packages\/new$/);

  await page.getByTestId("price-regular-evening").fill("50000");
  await expect(page.getByTestId("prices-error")).toBeHidden();
  for (const name of [dj, photos]) {
    await page.getByTestId("add-item").click();
    await page.getByRole("option", { name }).click();
  }
  await page.getByLabel(`الكمية: ${photos}`).fill("2");
  await expect(page.getByLabel(`الكمية: ${dj}`)).toBeDisabled();
  await page.getByLabel(`قابلة للإزالة: ${dj}`).check();
  await page.getByLabel(`قيمة الإزالة (جنيه): ${dj}`).fill("1000");
  await page.getByRole("button", { name: "حفظ" }).click();

  await expect(page).toHaveURL(/\/settings\/packages$/);
  const row = page.getByTestId("package-row").filter({ hasText: silver });
  await expect(row).toContainText("مسائي");
  await expect(row).toContainText("نشط");
});

test("a stale package page cannot overwrite another save (D-81)", async ({ page, context }, info) => {
  const silver = `الفضي ${suffix(info)}`;
  await signIn(page, usersOf(info).manager);
  await page.goto("/settings/packages");
  await page.getByTestId("package-row").filter({ hasText: silver }).getByRole("link", { name: silver }).click();
  await expect(page).toHaveURL(/\/settings\/packages\/[0-9a-f-]{36}$/);

  // The same package opened in a second tab, before the first one saves.
  const other = await context.newPage();
  await other.goto(page.url());
  await page.getByLabel("الوصف (اختياري)").fill("حفظ الصفحة الأولى");
  await page.getByRole("button", { name: "حفظ" }).click();
  await expect(page.getByTestId("saved-note")).toHaveText("تم الحفظ.");

  await other.getByTestId("price-regular-evening").fill("1");
  await other.getByRole("button", { name: "حفظ" }).click();
  await expect(other.getByTestId("package-conflict")).toContainText(
    "الباكيج اتعدّل من شخص تاني. حدّث الصفحة وراجع التعديلات",
  );
  await other.getByRole("button", { name: "حدّث الصفحة" }).click();
  await expect(other.getByLabel("الوصف (اختياري)")).toHaveValue("حفظ الصفحة الأولى");
  await expect(other.getByTestId("price-regular-evening")).toHaveValue("50000");

  // The first page keeps working on its new version.
  // The note may still show the first save's text, so wait for this save's own response.
  await page.getByLabel("الوصف (اختياري)").fill("حفظ ثانٍ");
  const secondSaved = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      "next-action" in r.request().headers() &&
      new URL(r.url()).pathname === new URL(page.url()).pathname,
  );
  await page.getByRole("button", { name: "حفظ" }).click();
  await secondSaved;
  await expect(page.getByTestId("saved-note")).toHaveText("تم الحفظ.");
  await expect(page.getByTestId("package-conflict")).toHaveCount(0);
  await other.close();
});

test("the guided setup shows services and packages done once the catalog has them (UF-02)", async ({ page }, info) => {
  await signIn(page, usersOf(info).owner);
  await page.goto("/setup");
  for (const key of ["services", "packages"]) {
    const step = page.getByTestId(`setup-step-${key}`);
    await expect(step).toHaveAttribute("data-status", "done");
    await expect(step.getByRole("link")).toBeVisible();
  }
});

test("the receptionist cannot open the catalog screens by direct link", async ({ page }, info) => {
  await signIn(page, usersOf(info).reception);
  for (const path of ["/settings/services", "/settings/packages", "/settings/packages/new"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/forbidden$/);
  }
});
