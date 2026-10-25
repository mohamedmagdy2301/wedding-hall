import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { eq } from "drizzle-orm";
import { createDb } from "../../src/db/client";
import { cancellationTiers, users, venues } from "../../src/db/schema";
import { addDays, cairoDate } from "../../src/lib/time";
import type { SessionUser } from "../../src/modules/auth/sessions";
import { createPasswordHasher } from "../../src/modules/auth/password/hasher";
import { OWASP_DEFAULT } from "../../src/modules/auth/password/params";
import { loadArgon2ModuleFromDisk } from "../../src/modules/auth/password/wasm-node";
import { confirmBooking } from "../../src/modules/bookings/confirm";
import { createTentative } from "../../src/modules/bookings/service";
import { createPackage } from "../../src/modules/packages/service";
import { createListItem } from "../../src/modules/settings/lists";
import { createSpace } from "../../src/modules/spaces/service";
import { E2E_DATABASE_URL, E2E_P2_PASSWORD, E2E_P2_USERS, E2E_WS_PROXY } from "./env";

/**
 * Phase 8 journeys (PHASE8_PLAN §4, TESTING.md): postponing to a cheaper and to a dearer slot,
 * cancelling with the suggested refund, and the reception cancelling a tentative booking
 * (Q8-05). The package: evening 60,000, day 40,000; deposits 15,000 (10,000 on the day
 * booking). The venue's tiers when the bookings are confirmed: 90 days → 75%, 30 → 50%, 0 → 0%
 * on the deposit — the one cancelled is 120 days ahead: 11,250 back, 3,750 kept.
 */
test.describe.configure({ mode: "serial" });

const suffix = (info: TestInfo) => (info.project.name === "desktop" ? "د" : "م");
const usersOf = (info: TestInfo) => E2E_P2_USERS[info.project.name as keyof typeof E2E_P2_USERS];

type World = {
  cheaperNo: string;
  dearerNo: string;
  cancelNo: string;
  tentativeNo: string;
  method: string;
  newDate: string;
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

    await db
      .update(venues)
      .set({
        phone: "0223456789",
        address: "القاهرة",
        minDepositType: "none",
        minDepositValue: 0,
        cancellationBasis: "deposit",
        postponeCreditMode: "refund",
      })
      .where(eq(venues.id, actor.venueId));
    await db.delete(cancellationTiers).where(eq(cancellationTiers.venueId, actor.venueId));
    await db.insert(cancellationTiers).values([
      { venueId: actor.venueId, minDaysBefore: 90, refundBps: 7500 },
      { venueId: actor.venueId, minDaysBefore: 30, refundBps: 5000 },
      { venueId: actor.venueId, minDaysBefore: 0, refundBps: 0 },
    ]);
    const method = `كاش ${s}8`;
    const { id: methodId } = await createListItem(deps, actor, { kind: "paymentMethods", name: method });
    const { id: spaceId } = await createSpace(deps, actor, {
      name: `قاعة التأجيل ${s}`,
      capacityMax: 400,
      day: { start: "13:00", end: "18:00" },
      evening: { start: "20:00", end: "01:00" },
    });
    const { id: weddingId } = await createListItem(deps, actor, {
      kind: "eventTypes",
      name: `فرح ${s}8`,
      isWedding: true,
    });
    const { id: packageId } = await createPackage(deps, actor, {
      spaceId,
      name: `الذهبي ${s}8`,
      description: null,
      baseGuests: 200,
      extraGuestPrice: 15_000,
      isActive: true,
      prices: [
        { slotKind: "day", seasonId: null, price: 4_000_000 },
        { slotKind: "evening", seasonId: null, price: 6_000_000 },
      ],
      items: [],
    });

    const tentative = (eventDate: string, slotKind: "day" | "evening", phone: string) =>
      createTentative(deps, actor, {
        spaceId,
        slotKind,
        startTime: null,
        endTime: null,
        eventDate,
        eventTypeId: weddingId,
        groomName: "أحمد",
        brideName: "منى",
        packageId,
        guests: 200,
        notes: null,
        items: [],
        removedServiceIds: [],
        customer: { name: `عميل التأجيل ${s}`, phone, altPhone: null },
      });
    const confirmed = async (eventDate: string, slotKind: "day" | "evening", phone: string, deposit: number) => {
      const t = await tentative(eventDate, slotKind, phone);
      await confirmBooking(deps, actor, {
        bookingId: t.id,
        version: t.version,
        expectedTotal: slotKind === "day" ? 4_000_000 : 6_000_000,
        deposit: { amount: deposit, methodId, paidAt: null },
        installments: [],
      });
      return t.bookingNo;
    };
    const phone = (n: number) => `0128880${s === "د" ? "1" : "2"}${String(n).padStart(3, "0")}`;
    const cheaperNo = await confirmed(addDays(today, 60), "evening", phone(1), 1_500_000);
    const dearerNo = await confirmed(addDays(today, 62), "day", phone(2), 1_000_000);
    const cancelNo = await confirmed(addDays(today, 120), "evening", phone(3), 1_500_000);
    const { bookingNo: tentativeNo } = await tentative(addDays(today, 64), "evening", phone(4));
    return { cheaperNo, dearerNo, cancelNo, tentativeNo, method, newDate: addDays(today, 70) };
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

async function openBooking(page: Page, bookingNo: string) {
  await page.goto(`/bookings?search=${bookingNo}`);
  await page.getByRole("link", { name: bookingNo }).click();
  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}$/);
}

async function chooseSlot(page: Page, name: string) {
  await page.getByTestId("postpone-slot").click();
  await page.getByRole("option", { name }).click();
}

test("P8-E1: the reception postpones an evening to a day slot — 60,000 becomes 40,000 (BR-81)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).reception);
  await openBooking(page, world.cheaperNo);
  await page.getByTestId("postpone-booking").click();
  const dialog = page.getByTestId("postpone-dialog");
  await dialog.getByTestId("postpone-date").fill(world.newDate);
  await chooseSlot(page, "نهاري");
  await expect(dialog.getByTestId("postpone-total-after")).toContainText("٤٠٬٠٠٠");
  await dialog.getByTestId("postpone-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("booking-total")).toContainText("٤٠٬٠٠٠");
  await expect(page.getByTestId("booking-balance")).toContainText("٢٥٬٠٠٠");
  // The reception cannot cancel a confirmed booking (Q8-05).
  await expect(page.getByTestId("cancel-booking")).toHaveCount(0);
});

test("P8-E2: the manager postpones a day booking to an evening — 40,000 becomes 60,000, the remaining 50,000", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).manager);
  await openBooking(page, world.dearerNo);
  await page.getByTestId("postpone-booking").click();
  const dialog = page.getByTestId("postpone-dialog");
  await chooseSlot(page, "مسائي");
  await expect(dialog.getByTestId("postpone-total-after")).toContainText("٦٠٬٠٠٠");
  await dialog.getByTestId("postpone-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("booking-total")).toContainText("٦٠٬٠٠٠");
  await expect(page.getByTestId("booking-balance")).toContainText("٥٠٬٠٠٠");
});

test("P8-E3: the manager cancels with the suggested 11,250 — a refund receipt, 3,750 kept, the booking frozen (BR-70..76)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).manager);
  await openBooking(page, world.cancelNo);
  await page.getByTestId("cancel-booking").click();
  const dialog = page.getByTestId("cancel-dialog");
  await expect(dialog.getByTestId("cancel-suggested")).toContainText("١١٬٢٥٠");
  await expect(dialog.getByTestId("cancel-retained")).toContainText("٣٬٧٥٠");
  await dialog.getByTestId("payment-method").click();
  await page.getByRole("option", { name: world.method }).click();
  await dialog.getByTestId("cancel-reason").fill("العريس سافر");
  await expect(dialog.getByTestId("cancel-submit")).toBeDisabled();
  await dialog.getByTestId("cancel-type-number").fill(world.cancelNo);
  await dialog.getByTestId("cancel-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("booking-cancelled")).toContainText("العريس سافر");
  await expect(page.getByTestId("cancel-booking")).toHaveCount(0);
  await expect(page.getByTestId("postpone-booking")).toHaveCount(0);
  await page.getByTestId("tab-payments").click();
  await expect(page.getByTestId("ledger-retained")).toContainText("٣٬٧٥٠");
  await expect(page.getByTestId("ledger-refunded")).toContainText("١١٬٢٥٠");
  await expect(page.getByTestId("record-payment")).toHaveCount(0);
});

test("P8-E4: the reception cancels a tentative booking with a reason, no money involved (Q8-05, BR-75)", async ({
  page,
}, info) => {
  await signIn(page, usersOf(info).reception);
  await openBooking(page, world.tentativeNo);
  await page.getByTestId("cancel-booking").click();
  const dialog = page.getByTestId("cancel-dialog");
  await expect(dialog).toContainText("مبدئي");
  await dialog.getByTestId("cancel-reason").fill("العميل اعتذر");
  await dialog.getByTestId("cancel-type-number").fill(world.tentativeNo);
  await dialog.getByTestId("cancel-submit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("booking-cancelled")).toContainText("العميل اعتذر");
});
