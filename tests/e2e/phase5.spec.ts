import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { and, eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { roles, userRoles, users, venues } from "../../src/db/schema";
import { addDays, cairoDate } from "../../src/lib/time";
import type { SessionUser } from "../../src/modules/auth/sessions";
import { createPasswordHasher } from "../../src/modules/auth/password/hasher";
import { OWASP_DEFAULT } from "../../src/modules/auth/password/params";
import { loadArgon2ModuleFromDisk } from "../../src/modules/auth/password/wasm-node";
import { markConfirmed } from "../../src/modules/bookings/confirm-transition";
import { createTentative } from "../../src/modules/bookings/service";
import { createService } from "../../src/modules/catalog/services";
import { createPackage } from "../../src/modules/packages/service";
import { createListItem } from "../../src/modules/settings/lists";
import { createSpace } from "../../src/modules/spaces/service";
import { E2E_DATABASE_URL, E2E_P2_PASSWORD, E2E_P2_USERS, E2E_WS_PROXY } from "./env";

/**
 * Phase 5 journeys (PHASE5_PLAN §9.6, E-01..E-11). The catalog and two bookings that the UI
 * cannot make yet are prepared here, per project: a confirmed booking through
 * `markConfirmed` (confirming is phase 6 — D-97) and a tentative booking saved three days
 * ago, so it is expired. Dates are relative to today, in Cairo.
 */
test.describe.configure({ mode: "serial" });

const suffix = (info: TestInfo) => (info.project.name === "desktop" ? "د" : "م");
const usersOf = (info: TestInfo) => E2E_P2_USERS[info.project.name as keyof typeof E2E_P2_USERS];

type World = {
  spaceId: string;
  space: string;
  packageName: string;
  dj: string;
  confirmedNo: string;
  expiredNo: string;
  existingPhone: string;
  existingName: string;
  accountant: string;
  dates: { confirmed: string; expired: string; wizard: string; quick: string };
};

let world: World;

async function prepare(info: TestInfo): Promise<World> {
  const s = suffix(info);
  const handle = createDb(E2E_DATABASE_URL, { localWsProxy: E2E_WS_PROXY || undefined });
  try {
    const db = handle.db;
    const [owner] = await db
      .select({ id: users.id, venueId: users.venueId, name: users.name, login: users.login })
      .from(users)
      .where(eq(users.login, usersOf(info).owner));
    const actor: SessionUser = {
      sessionId: "e2e",
      userId: owner.id,
      venueId: owner.venueId,
      name: owner.name,
      login: owner.login,
      isOwner: true,
      mustChangePassword: false,
      permissions: new Set(),
      expiresAt: new Date(),
    };
    const hasher = createPasswordHasher(loadArgon2ModuleFromDisk(), OWASP_DEFAULT);
    const deps = { db, hasher, now: new Date() };
    const today = cairoDate(deps.now);
    const dates = {
      confirmed: addDays(today, 21),
      expired: addDays(today, 25),
      wizard: addDays(today, 28),
      quick: addDays(today, 30),
    };

    const space = `قاعة الحجوزات ${s}`;
    const { id: spaceId } = await createSpace(deps, actor, {
      name: space,
      capacityMax: 300,
      day: { start: "13:00", end: "18:00" },
      evening: { start: "20:00", end: "01:00" },
    });
    const { id: weddingId } = await createListItem(deps, actor, {
      kind: "eventTypes",
      name: `فرح ${s}5`,
      isWedding: true,
    });
    const dj = `دي جي ${s}5`;
    const { id: djId } = await createService(deps, actor, {
      name: dj,
      category: "service",
      pricingType: "fixed",
      unitPrice: 300_000,
      allowExternal: true,
      externalFee: 50_000,
    });
    const packageName = `الماسي ${s}`;
    const { id: packageId } = await createPackage(deps, actor, {
      spaceId,
      name: packageName,
      description: null,
      baseGuests: 200,
      extraGuestPrice: 15_000,
      isActive: true,
      prices: [
        { slotKind: "day", seasonId: null, price: 3_000_000 },
        { slotKind: "evening", seasonId: null, price: 5_000_000 },
      ],
      items: [{ serviceId: djId, quantity: 1, removable: true, removalCredit: 100_000 }],
    });

    const base = {
      spaceId,
      slotKind: "evening" as const,
      startTime: null,
      endTime: null,
      groomName: null,
      brideName: null,
      notes: null,
      items: [],
      removedServiceIds: [],
    };
    const existingPhone = s === "د" ? "01099990001" : "01099990002";
    const existingName = `عميل قديم ${s}`;
    const confirmed = await createTentative(deps, actor, {
      ...base,
      eventDate: dates.confirmed,
      eventTypeId: weddingId,
      packageId,
      guests: 200,
      customer: { name: existingName, phone: existingPhone, altPhone: null },
    });
    await db.transaction((tx) =>
      markConfirmed(tx, {
        venueId: actor.venueId,
        bookingId: confirmed.id,
        confirmedBy: actor.userId,
        now: deps.now,
        bufferMinutes: 60,
        cancellationBasis: "deposit",
        cancellationTiers: [{ minDaysBefore: 0, refundBps: 0 }],
      }),
    );
    const [venue] = await db
      .select({ hold: venues.tentativeHoldHours })
      .from(venues)
      .where(eq(venues.id, actor.venueId));
    const expired = await createTentative(
      { ...deps, now: new Date(deps.now.getTime() - (venue.hold + 24) * 3_600_000) },
      actor,
      {
        ...base,
        eventDate: dates.expired,
        eventTypeId: null,
        packageId: null,
        guests: null,
        customer: { name: `عميل منتهي ${s}`, phone: "01055550000", altPhone: null },
      },
    );

    // An accountant (bookings.view only among the booking permissions), ready to sign in.
    const accountant = `p5.accountant${s === "د" ? "" : ".m"}`;
    const [role] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.venueId, actor.venueId), eq(roles.name, "محاسب")));
    const [user] = await db
      .insert(users)
      .values({
        venueId: actor.venueId,
        name: accountant,
        login: accountant,
        passwordHash: hasher.hash(E2E_P2_PASSWORD),
        mustChangePassword: false,
      })
      .returning({ id: users.id });
    await db.insert(userRoles).values({ userId: user.id, roleId: role.id });

    return {
      spaceId,
      space,
      packageName,
      dj,
      confirmedNo: confirmed.bookingNo,
      expiredNo: expired.bookingNo,
      existingPhone,
      existingName,
      accountant,
      dates,
    };
  } finally {
    await handle.close();
  }
}

test.beforeAll(async ({}, info) => {
  world = await prepare(info);
});

async function signIn(page: Page, login: string) {
  await page.goto("/login");
  await page.getByLabel("رقم الموبايل أو اسم المستخدم").fill(login);
  await page.getByLabel("كلمة المرور").fill(E2E_P2_PASSWORD);
  await page.getByRole("button", { name: "دخول" }).click();
  await expect(page).toHaveURL(/\/$/);
}

const bookingIdOf = (page: Page) => new URL(page.url()).pathname.split("/")[2];

test("E-01: from an empty calendar slot, the wizard prices live and saves a tentative booking that shows in the calendar", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).reception);
  const { spaceId, dates } = world;
  await page.goto(`/calendar?view=week&date=${dates.wizard}&space=${spaceId}`);
  await page.getByTestId(`cell-${spaceId}-${dates.wizard}-evening`).getByTestId("calendar-new").click();
  await expect(page).toHaveURL(/\/bookings\/new\?/);
  await expect(page.getByTestId("wizard-date")).toHaveValue(dates.wizard);
  await expect(page.getByTestId("availability")).toContainText("الموعد متاح");

  await page.getByRole("button", { name: /المناسبة والباكيج/ }).click();
  await page.getByTestId("wizard-package").click();
  await page.getByRole("option", { name: world.packageName }).click();
  await page.getByTestId("wizard-guests").fill("230");
  const total =
    info.project.name === "desktop"
      ? page.locator("aside").getByTestId("price-total")
      : page.getByTestId("mobile-price-bar");
  // 50,000 + 30 × 150 = 54,500
  await expect(total).toContainText("٥٤٬٥٠٠");

  await page.getByRole("button", { name: /التخصيص/ }).click();
  await page.getByLabel("شيلها من الباكيج").check();
  await expect(total).toContainText("٥٣٬٥٠٠");

  await page
    .getByRole("button", { name: /العميل/ })
    .first()
    .click();
  await page.getByTestId("customer-phone").fill(info.project.name === "desktop" ? "01200000001" : "01200000002");
  await page.getByTestId("customer-name").fill(`عميل المعالج ${suffix(info)}`);
  await page.getByTestId("save-tentative").click();

  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("booking-status")).toHaveText("مبدئي");
  await expect(page.getByTestId("booking-expiry")).toContainText("صلاحية المبدئي");
  await expect(page.getByTestId("booking-total")).toContainText("٥٣٬٥٠٠");

  await page.goto(`/calendar?view=week&date=${dates.wizard}&space=${spaceId}`);
  await expect(page.getByTestId(`cell-${spaceId}-${dates.wizard}-evening`).getByTestId("calendar-booking")).toHaveText(
    `عميل المعالج ${suffix(info)}`,
  );
});

test("E-02 / E-03: save as tentative from the first step with only a mobile, linking the suggested existing customer (D-09, D-28)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).reception);
  await page.goto(`/bookings/new?space=${world.spaceId}&date=${world.dates.quick}&slot=day`);
  await page.getByTestId("save-tentative").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("customer-phone").fill(world.existingPhone);
  await expect(dialog.getByTestId("customer-matches")).toContainText(world.existingName);
  await dialog.getByRole("button", { name: "اربط بالعميل ده" }).click();
  await dialog.getByTestId("quick-save").click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("link", { name: world.existingName })).toBeVisible();
});

test("E-04: a tentative booking on a confirmed slot warns with its number, saves, and shows as conflicting (BR-12, BR-13)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).reception);
  await page.goto(`/bookings/new?space=${world.spaceId}&date=${world.dates.confirmed}&slot=evening`);
  await expect(page.getByTestId("confirmed-conflict")).toContainText(world.confirmedNo);
  await page.getByTestId("save-tentative").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByTestId("customer-phone").fill(info.project.name === "desktop" ? "01200000011" : "01200000012");
  await dialog.getByTestId("customer-name").fill(`عميل متعارض ${suffix(info)}`);
  await dialog.getByTestId("quick-save").click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId("booking-status")).toHaveText("متعارض");
  await expect(page.getByTestId("booking-conflict")).toContainText(world.confirmedNo);

  await page.goto(`/calendar?view=week&date=${world.dates.confirmed}&space=${world.spaceId}`);
  const cell = page.getByTestId(`cell-${world.spaceId}-${world.dates.confirmed}-evening`);
  await expect(cell.locator('[data-status="conflicting"]')).toBeVisible();
  await expect(cell.locator('[data-status="confirmed"]')).toBeVisible();
});

test("E-05 / E-06: an expired tentative booking shows as expired, is hidden in the calendar unless asked; the list searches by number and mobile", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).reception);
  await page.goto(`/bookings?search=${world.expiredNo}`);
  const row = page.getByTestId("booking-row");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("booking-status")).toHaveText("منتهي");

  await page.goto(`/bookings?search=${world.existingPhone}`);
  await expect(page.getByTestId("booking-row").filter({ hasText: world.confirmedNo })).toBeVisible();

  await page.goto(`/calendar?view=week&date=${world.dates.expired}&space=${world.spaceId}`);
  const cell = page.getByTestId(`cell-${world.spaceId}-${world.dates.expired}-evening`);
  await expect(cell.getByTestId("calendar-booking")).toHaveCount(0);
  await page.getByTestId("calendar-show-all").click();
  await expect(cell.locator('[data-status="expired"]')).toBeVisible();
});

test("E-11: extending an expired tentative booking makes it tentative again (D-101)", async ({ page }, info) => {
  await signIn(page, usersOf(info).reception);
  await page.goto(`/bookings?search=${world.expiredNo}`);
  await page.getByRole("link", { name: world.expiredNo }).click();
  await expect(page.getByTestId("booking-status")).toHaveText("منتهي");
  await page.getByTestId("extend-booking").click();
  await page.getByRole("dialog").getByRole("button", { name: "تمديد" }).click();
  await expect(page.getByTestId("booking-status")).toHaveText("مبدئي");
  await page.getByRole("tab", { name: "السجل" }).click();
  await expect(page.getByTestId("booking-history")).toContainText("تمديد حجز مبدئي");
});

test("E-07: editing a tentative booking re-prices it (D-101)", async ({ page }, info) => {
  await signIn(page, usersOf(info).reception);
  await page.goto(`/bookings?search=${encodeURIComponent(`عميل المعالج ${suffix(info)}`)}`);
  await page.getByTestId("booking-row").getByRole("link").first().click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
  const id = bookingIdOf(page);
  await page.getByRole("link", { name: "تعديل" }).click();
  await page.getByTestId("wizard-slot").click();
  await page.getByRole("option", { name: "نهاري" }).click();
  // The package has a day price, so it stays with its removed DJ: 30,000 − 1,000.
  await page.getByRole("button", { name: /المناسبة والباكيج/ }).click();
  await page.getByTestId("wizard-guests").fill("200");
  await page.getByTestId("save-tentative").click();
  await expect(page).toHaveURL(new RegExp(`/bookings/${id}$`));
  await expect(page.getByTestId("booking-total")).toContainText("٢٩٬٠٠٠");
});

test("E-09: the accountant sees the calendar and bookings but cannot create one", async ({ page }) => {
  await signIn(page, world.accountant);
  await page.goto("/calendar");
  await expect(page.getByRole("heading", { name: "التقويم" })).toBeVisible();
  await expect(page.getByRole("link", { name: "حجز جديد" })).toHaveCount(0);
  await page.goto("/bookings/new");
  await expect(page).toHaveURL(/\/forbidden$/);
});

test("E-10: on a phone the calendar opens on the day view and the wizard keeps the total at the bottom", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "phone layout only");
  await signIn(page, usersOf(info).reception);
  await page.goto("/calendar");
  await expect(page).toHaveURL(/view=day/);
  await expect(page.getByTestId("calendar-day")).toBeVisible();
  await page.goto("/bookings/new");
  await expect(page.getByTestId("mobile-price-bar")).toBeVisible();
});

test("E-08: deactivating a space warns with its upcoming bookings, keeps them, and removes it from the wizard (D-75)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).manager);
  await page.goto("/settings/spaces");
  await page.getByRole("button", { name: `إجراءات: ${world.space}` }).click();
  await page.getByRole("menuitem", { name: "تعطيل" }).click();
  const dialog = page.getByRole("dialog");
  // The confirmed booking and the live tentative ones (E-01, E-02, E-04, the extended E-11).
  await expect(dialog.getByTestId("space-upcoming")).toContainText("١ مؤكد");
  await dialog.getByRole("button", { name: "تعطيل" }).click();
  await expect(dialog).toBeHidden();

  await page.goto(`/bookings?search=${world.confirmedNo}`);
  await expect(page.getByTestId("booking-row").getByTestId("booking-status")).toHaveText("مؤكد");
  await page.goto("/bookings/new");
  await page.getByTestId("wizard-space").click();
  await expect(page.getByRole("option", { name: world.space })).toHaveCount(0);
});
