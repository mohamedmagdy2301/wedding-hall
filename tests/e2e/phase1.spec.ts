import { expect, test, type Page } from "@playwright/test";
import { E2E_OWNERS, E2E_TEMP_PASSWORD, E2E_VENUE_NAME } from "./env";

/**
 * Phase 1 journeys (TESTING.md §3, PHASE1_PLAN E2E): temporary password → forced change,
 * adding a reception employee, reception cannot open the staff screen, and shadcn/ui
 * dialogs/menus behaving correctly in RTL (P1-05). Serial: each step builds on the last.
 */
test.describe.configure({ mode: "serial" });

const NEW_PASSWORD = "e2e-new-pass-1";

async function signIn(page: Page, login: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("رقم الموبايل أو اسم المستخدم").fill(login);
  await page.getByLabel("كلمة المرور").fill(password);
  await page.getByRole("button", { name: "دخول" }).click();
}

async function changeTemporaryPassword(page: Page, from: string, to: string) {
  await expect(page).toHaveURL(/\/change-password$/);
  await expect(page.getByText("دخلت بكلمة مرور مؤقتة")).toBeVisible();
  await page.getByLabel("كلمة المرور الحالية").fill(from);
  await page.getByLabel("كلمة المرور الجديدة (8 أحرف على الأقل)").fill(to);
  await page.getByLabel("تأكيد كلمة المرور الجديدة").fill(to);
  await page.getByRole("button", { name: "تغيير كلمة المرور" }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function signOut(page: Page) {
  await page.getByTestId("account-menu").click();
  await page.getByRole("menuitem", { name: "خروج" }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test("a signed-out visitor is sent to the RTL login page", async ({ page }) => {
  await page.goto("/staff");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.getByRole("heading", { name: "تسجيل الدخول" })).toBeVisible();
});

test("a wrong password gets one generic message (SEC-03)", async ({ page }, info) => {
  const owner = E2E_OWNERS[info.project.name as keyof typeof E2E_OWNERS];
  await signIn(page, owner.login, "wrong-password");
  await expect(page.getByRole("alert").filter({ hasText: "تعذّر تسجيل الدخول" })).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

test("the owner signs in with the temporary password and must change it first (SEC-05)", async ({ page }, info) => {
  const owner = E2E_OWNERS[info.project.name as keyof typeof E2E_OWNERS];
  await signIn(page, owner.login, E2E_TEMP_PASSWORD);
  await expect(page).toHaveURL(/\/change-password$/);
  // Other pages are not reachable until the password is changed.
  await page.goto("/staff");
  await expect(page).toHaveURL(/\/change-password$/);

  // On the home page the shell re-issues the session cookie with the slid expiry (T-17).
  const cookieRefresh = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && "next-action" in r.request().headers() && new URL(r.url()).pathname === "/",
  );
  await changeTemporaryPassword(page, E2E_TEMP_PASSWORD, NEW_PASSWORD);
  await expect(page.getByTestId("welcome")).toContainText(owner.name);
  await expect(page.getByRole("link", { name: E2E_VENUE_NAME })).toBeVisible();
  const refresh = await cookieRefresh;
  expect(refresh.status()).toBe(200);
  expect(await refresh.headerValue("set-cookie")).toContain("wh_session=");
});

test("the owner adds a reception employee; dialog and menus render RTL (UF-11, P1-05)", async ({ page }, info) => {
  const owner = E2E_OWNERS[info.project.name as keyof typeof E2E_OWNERS];
  await signIn(page, owner.login, NEW_PASSWORD);
  await page.getByRole("link", { name: "الموظفون والأدوار" }).click();
  await expect(page.getByRole("heading", { name: "الموظفون والأدوار", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "إضافة موظف" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
  // In RTL the close button sits on the left (inline-end) side of the dialog.
  const box = (await dialog.boundingBox())!;
  const close = (await dialog.getByRole("button", { name: "إغلاق" }).boundingBox())!;
  expect(close.x + close.width / 2).toBeLessThan(box.x + box.width / 2);
  // The dialog stays inside the viewport (no overflow from mirrored transforms).
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);

  const login = `reception.${info.project.name}`;
  await dialog.getByLabel("الاسم").fill("موظفة الاستقبال");
  await dialog.getByLabel("رقم الموبايل أو اسم المستخدم").fill(login);
  await dialog.getByLabel("كلمة مرور مؤقتة (8 أحرف على الأقل)").fill(E2E_TEMP_PASSWORD);
  await dialog.getByLabel("استقبال/حجوزات").check();
  await dialog.getByRole("button", { name: "حفظ" }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByTestId(`user-row-${login}`);
  await expect(row).toContainText("استقبال/حجوزات");
  await expect(row).toContainText("لم يغيّر كلمة المرور المؤقتة");

  // Row menu opens in RTL and inside the viewport.
  await row.getByRole("button", { name: /إجراءات/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("dir", "rtl");
  const menuBox = (await menu.boundingBox())!;
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width + 1);
  await page.keyboard.press("Escape");

  // The new employee and the setup are in the audit log.
  await page.getByRole("link", { name: "سجل العمليات" }).click();
  await expect(page.getByRole("cell", { name: "إضافة موظف" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "تجهيز المنشأة" })).toBeVisible();
});

test("the reception employee cannot open the staff screen (SEC-10)", async ({ page }, info) => {
  const login = `reception.${info.project.name}`;
  await signIn(page, login, E2E_TEMP_PASSWORD);
  await changeTemporaryPassword(page, E2E_TEMP_PASSWORD, NEW_PASSWORD);

  await expect(page.getByRole("link", { name: "الموظفون والأدوار" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "سجل العمليات" })).toHaveCount(0);
  await page.goto("/staff");
  await expect(page).toHaveURL(/\/forbidden$/);
  await expect(page.getByRole("heading", { name: "لا تملك صلاحية لفتح هذه الصفحة" })).toBeVisible();
  await page.goto("/audit");
  await expect(page).toHaveURL(/\/forbidden$/);

  await signOut(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

/**
 * SEC-22: Server Actions are protected against CSRF by Next.js comparing Origin with Host.
 * A real login request is captured, then replayed with valid credentials twice: from the
 * site's own origin it signs in; from a foreign origin it is refused and creates no session.
 */
test("a Server Action from a foreign Origin is refused (SEC-22)", async ({ page, baseURL }, info) => {
  const login = `reception.${info.project.name}`;
  await page.goto("/login");
  await page.getByLabel("رقم الموبايل أو اسم المستخدم").fill(login);
  await page.getByLabel("كلمة المرور").fill(NEW_PASSWORD);
  const captured = page.waitForRequest((r) => r.method() === "POST" && "next-action" in r.headers());
  await page.getByRole("button", { name: "دخول" }).click();
  const request = await captured;
  await expect(page).toHaveURL(/\/$/);
  await signOut(page);

  const headers = await request.allHeaders();
  const replay = (origin: string) =>
    page.request.post(request.url(), {
      headers: {
        "next-action": headers["next-action"],
        "next-router-state-tree": headers["next-router-state-tree"] ?? "",
        "content-type": headers["content-type"],
        accept: headers.accept ?? "text/x-component",
        origin,
      },
      data: request.postData() ?? "",
      maxRedirects: 0,
    });
  const sessionCookieSet = (r: Awaited<ReturnType<typeof replay>>) =>
    r.headersArray().some((h) => h.name.toLowerCase() === "set-cookie" && h.value.startsWith("wh_session="));

  const sameOrigin = await replay(new URL(baseURL!).origin);
  expect(sameOrigin.status()).toBe(200);
  expect(sessionCookieSet(sameOrigin)).toBe(true);

  const foreign = await replay("https://evil.example");
  expect(foreign.ok()).toBe(false);
  expect(sessionCookieSet(foreign)).toBe(false);
});
