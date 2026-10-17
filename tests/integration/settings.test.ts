import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { auditLogs, cancellationTiers, eventTypes, seasons, spaces, venues } from "@/db/schema";
import { slotViolations } from "@/domain/slots";
import { VENUE_DEFAULTS } from "@/modules/settings/setup";
import { bookingReadiness, getSetupChecklist } from "@/modules/settings/checklist";
import { listItems } from "@/modules/settings/lists";
import { listSeasons } from "@/modules/settings/seasons";
import { getVenueSettings } from "@/modules/settings/venue";
import { listSpaces } from "@/modules/spaces/service";
import type { ProtectedSpec } from "@/server/specs/define";
import { settingsSpecs } from "@/server/specs/settings";
import { spaceSpecs } from "@/server/specs/spaces";
import { connectTestDb, truncateAll } from "./helpers/db";
import { addStaff, auditActions, callSpec, setUpVenueWithOwner } from "./helpers/fixtures";

const hall = {
  name: "القاعة الكبرى",
  capacityMax: "500",
  day: { start: "12:00", end: "17:00" },
  evening: { start: "18:00", end: "23:00" },
};

const policies = {
  minDepositType: "percent",
  minDepositValue: "10",
  cancellationBasis: "deposit",
  postponeCreditMode: "both",
  tiers: [
    { minDaysBefore: "0", refundBps: "0" },
    { minDaysBefore: "30", refundBps: "50" },
    { minDaysBefore: "90", refundBps: "100" },
  ],
};

describe("settings and spaces (phase 2)", () => {
  const handle = connectTestDb();
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  /** Owner, a manager (default role: catalog.manage, no settings.manage) and a receptionist. */
  async function scenario() {
    const base = await setUpVenueWithOwner(handle);
    const manager = await addStaff(handle, base.owner.actor, "manager", [base.roleId("مدير")]);
    const reception = await addStaff(handle, base.owner.actor, "reception", [base.roleId("استقبال/حجوزات")]);
    return { ...base, manager, reception };
  }

  type AnySpec = ProtectedSpec<z.ZodType, unknown>;

  const ok = <T>(result: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  };

  describe("SEC-11: every operation is refused without its permission or a session", () => {
    const venueOps = [
      [settingsSpecs.updateVenue, { name: "قاعة", phone: "", address: "" }],
      [settingsSpecs.updateTiming, { bufferMinutes: 30, tentativeHoldHours: 24 }],
      [settingsSpecs.updatePolicies, policies],
      [settingsSpecs.createListItem, { kind: "paymentMethods", name: "نقدي" }],
      [settingsSpecs.addSuggestedItems, { kind: "eventTypes" }],
    ] as unknown as [AnySpec, unknown][];
    const catalogOps = [
      [spaceSpecs.createSpace, hall],
      [settingsSpecs.createSeason, { name: "الصيف", startDate: "2026-06-01", endDate: "2026-08-31" }],
    ] as unknown as [AnySpec, unknown][];

    it("settings.manage operations: refused for the manager and the receptionist, and without a session", async () => {
      const s = await scenario();
      for (const [spec, input] of venueOps) {
        for (const token of [s.manager.token, s.reception.token]) {
          expect(await callSpec(handle, spec, token, input)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        }
        expect(await callSpec(handle, spec, undefined, input)).toMatchObject({
          ok: false,
          error: { code: "UNAUTHENTICATED" },
        });
      }
      expect(await auditActions(handle)).not.toContain("settings.policies_updated");
    });

    it("catalog.manage operations (spaces, seasons — D-66): the manager may, the receptionist may not", async () => {
      const s = await scenario();
      for (const [spec, input] of catalogOps) {
        expect(await callSpec(handle, spec, s.reception.token, input)).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN" },
        });
        expect(await callSpec(handle, spec, undefined, input)).toMatchObject({
          ok: false,
          error: { code: "UNAUTHENTICATED" },
        });
        expect((await callSpec(handle, spec, s.manager.token, input)).ok).toBe(true);
      }
    });

    it("the read functions check the permission too", async () => {
      const s = await scenario();
      await expect(getVenueSettings(handle.db, s.manager.actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(listItems(handle.db, s.reception.actor, "eventTypes")).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(listSpaces(handle.db, s.reception.actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(listSeasons(handle.db, s.reception.actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(getSetupChecklist(handle.db, s.manager.actor)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("venue data, timing and policies", () => {
    it("updates the venue data with an audit row (before/after)", async () => {
      const { owner } = await scenario();
      ok(
        await callSpec(handle, settingsSpecs.updateVenue, owner.token, {
          name: "قاعة النخيل",
          phone: "٠٢٢١٢٣٤٥٦٧",
          address: "مدينة نصر",
        }),
      );
      const settings = await getVenueSettings(handle.db, owner.actor);
      expect(settings).toMatchObject({ name: "قاعة النخيل", phone: "0221234567", address: "مدينة نصر" });
      const [row] = await handle.db.select().from(auditLogs).where(eq(auditLogs.action, "settings.venue_updated"));
      expect(row.before).toMatchObject({ name: "قاعة الاختبار", phone: null });
      expect(row.after).toMatchObject({ name: "قاعة النخيل" });
    });

    it("D-19, D-20, D-22, D-67: saves policies and replaces the tiers as one sorted set", async () => {
      const { owner } = await scenario();
      ok(await callSpec(handle, settingsSpecs.updatePolicies, owner.token, policies));
      ok(
        await callSpec(handle, settingsSpecs.updatePolicies, owner.token, {
          ...policies,
          minDepositType: "fixed",
          minDepositValue: "2,500.50",
          tiers: [{ minDaysBefore: "0", refundBps: "0" }],
          confirmNoRefund: true,
        }),
      );
      const settings = await getVenueSettings(handle.db, owner.actor);
      expect(settings).toMatchObject({ minDepositType: "fixed", minDepositValue: 250050, postponeCreditMode: "both" });
      expect(settings.tiers).toEqual([{ minDaysBefore: 0, refundBps: 0 }]);
    });

    it("D-74: a policy where every tier is 0% is saved only with explicit confirmation", async () => {
      const { owner } = await scenario();
      const noRefund = {
        ...policies,
        tiers: [
          { minDaysBefore: "0", refundBps: "0" },
          { minDaysBefore: "60", refundBps: "0" },
        ],
      };
      expect(await callSpec(handle, settingsSpecs.updatePolicies, owner.token, noRefund)).toMatchObject({
        ok: false,
        error: { code: "BUSINESS_RULE_VIOLATION", message: expect.stringContaining("أكّد") },
      });
      expect(
        await callSpec(handle, settingsSpecs.updatePolicies, owner.token, { ...noRefund, confirmNoRefund: false }),
      ).toMatchObject({ ok: false });
      expect(await handle.db.select().from(cancellationTiers)).toHaveLength(0);
      expect(await auditActions(handle)).not.toContain("settings.policies_updated");

      ok(await callSpec(handle, settingsSpecs.updatePolicies, owner.token, { ...noRefund, confirmNoRefund: true }));
      expect((await getVenueSettings(handle.db, owner.actor)).tiers).toHaveLength(2);
      // Any tier above 0% needs no confirmation.
      ok(await callSpec(handle, settingsSpecs.updatePolicies, owner.token, policies));
    });

    it("BR-77 / D-67: refuses no tiers, a decreasing refund, and a 0 deposit; nothing is changed", async () => {
      const { owner } = await scenario();
      ok(await callSpec(handle, settingsSpecs.updatePolicies, owner.token, policies));
      expect(
        await callSpec(handle, settingsSpecs.updatePolicies, owner.token, { ...policies, tiers: [] }),
      ).toMatchObject({
        ok: false,
        error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-77" },
      });
      const decreasing = [
        { minDaysBefore: "10", refundBps: "50" },
        { minDaysBefore: "20", refundBps: "25" },
      ];
      expect(
        await callSpec(handle, settingsSpecs.updatePolicies, owner.token, { ...policies, tiers: decreasing }),
      ).toMatchObject({ ok: false, error: { rule: "BR-77", fieldErrors: { tiers: expect.any(String) } } });
      expect(
        await callSpec(handle, settingsSpecs.updatePolicies, owner.token, { ...policies, minDepositValue: "0" }),
      ).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR", fieldErrors: { minDepositValue: expect.any(String) } },
      });
      const rows = await handle.db.select().from(cancellationTiers);
      expect(rows).toHaveLength(3);
    });
  });

  describe("BR-02 / D-51 / D-69: slots and the buffer", () => {
    it("creates a space with both slots, and refuses slots that break BR-02 with the current buffer (60)", async () => {
      const { owner } = await scenario();
      const { id } = ok(await callSpec(handle, spaceSpecs.createSpace, owner.token, hall));
      const [space] = await listSpaces(handle.db, owner.actor);
      expect(space).toMatchObject({ id, capacityMax: 500, day: hall.day, evening: hall.evening, isActive: true });

      const tooClose = { ...hall, name: "الروف", evening: { start: "17:30", end: "23:00" } };
      expect(await callSpec(handle, spaceSpecs.createSpace, owner.token, tooClose)).toMatchObject({
        ok: false,
        error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-02", fieldErrors: { "evening.start": expect.any(String) } },
      });
      const intoNextDay = { ...hall, name: "الحديقة", evening: { start: "18:00", end: "11:30" } };
      expect(await callSpec(handle, spaceSpecs.createSpace, owner.token, intoNextDay)).toMatchObject({
        ok: false,
        error: { rule: "BR-02", fieldErrors: { "evening.end": expect.any(String) } },
      });
      // A failed operation leaves neither a row nor an audit entry.
      expect(await listSpaces(handle.db, owner.actor)).toHaveLength(1);
      expect((await auditActions(handle)).filter((a) => a === "spaces.create")).toHaveLength(1);
    });

    it("an evening slot that crosses midnight is accepted (D-69)", async () => {
      const { owner } = await scenario();
      ok(
        await callSpec(handle, spaceSpecs.createSpace, owner.token, {
          ...hall,
          evening: { start: "19:00", end: "02:00" },
        }),
      );
    });

    it("D-51: a buffer that breaks BR-02 in any space — even an inactive one — is refused", async () => {
      const { owner } = await scenario();
      const { id } = ok(await callSpec(handle, spaceSpecs.createSpace, owner.token, hall));
      ok(await callSpec(handle, spaceSpecs.setSpaceActive, owner.token, { spaceId: id, active: false }));
      expect(
        await callSpec(handle, settingsSpecs.updateTiming, owner.token, { bufferMinutes: 61, tentativeHoldHours: 48 }),
      ).toMatchObject({ ok: false, error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-02" } });
      ok(
        await callSpec(handle, settingsSpecs.updateTiming, owner.token, { bufferMinutes: 60, tentativeHoldHours: 24 }),
      );
      const settings = await getVenueSettings(handle.db, owner.actor);
      expect(settings).toMatchObject({ bufferMinutes: 60, tentativeHoldHours: 24, maxBufferMinutes: 60 });
    });

    it("a slot change and a buffer change in parallel never leave BR-02 broken", async () => {
      const { owner } = await scenario();
      ok(
        await callSpec(handle, settingsSpecs.updateTiming, owner.token, { bufferMinutes: 30, tentativeHoldHours: 48 }),
      );
      const { id } = ok(await callSpec(handle, spaceSpecs.createSpace, owner.token, hall)); // gap 60
      for (let round = 0; round < 5; round++) {
        // Each is valid alone: buffer 60 with a 60-minute gap, or a 30-minute gap with buffer 30.
        const results = await Promise.all([
          callSpec(handle, settingsSpecs.updateTiming, owner.token, { bufferMinutes: 60, tentativeHoldHours: 48 }),
          callSpec(handle, spaceSpecs.updateSpace, owner.token, {
            ...hall,
            spaceId: id,
            evening: { start: "17:30", end: "23:00" },
          }),
        ]);
        expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
        const settings = await getVenueSettings(handle.db, owner.actor);
        const [space] = await listSpaces(handle.db, owner.actor);
        expect(slotViolations(space, settings.bufferMinutes)).toEqual([]);
        // Reset for the next round.
        ok(
          await callSpec(handle, settingsSpecs.updateTiming, owner.token, {
            bufferMinutes: 30,
            tentativeHoldHours: 48,
          }),
        );
        ok(await callSpec(handle, spaceSpecs.updateSpace, owner.token, { ...hall, spaceId: id }));
      }
    });
  });

  describe("BR-31: seasons", () => {
    const summer = { name: "الصيف", startDate: "2026-06-01", endDate: "2026-08-31" };

    it("refuses an overlapping active season with a field error, and refuses reactivating one", async () => {
      const { owner } = await scenario();
      ok(await callSpec(handle, settingsSpecs.createSeason, owner.token, summer));
      const overlap = { name: "العيد", startDate: "2026-08-31", endDate: "2026-09-05" };
      expect(await callSpec(handle, settingsSpecs.createSeason, owner.token, overlap)).toMatchObject({
        ok: false,
        error: { code: "BUSINESS_RULE_VIOLATION", rule: "BR-31", fieldErrors: { startDate: expect.any(String) } },
      });
      const { id: autumn } = ok(
        await callSpec(handle, settingsSpecs.createSeason, owner.token, {
          name: "الخريف",
          startDate: "2026-09-01",
          endDate: "2026-10-31",
        }),
      );
      ok(await callSpec(handle, settingsSpecs.setSeasonActive, owner.token, { seasonId: autumn, active: false }));
      ok(
        await callSpec(handle, settingsSpecs.updateSeason, owner.token, {
          seasonId: autumn,
          name: "الخريف",
          startDate: "2026-08-01",
          endDate: "2026-10-31",
        }),
      );
      expect(
        await callSpec(handle, settingsSpecs.setSeasonActive, owner.token, { seasonId: autumn, active: true }),
      ).toMatchObject({ ok: false, error: { rule: "BR-31" } });
    });

    it("two overlapping seasons created in parallel: exactly one succeeds", async () => {
      const { owner } = await scenario();
      const results = await Promise.all([
        callSpec(handle, settingsSpecs.createSeason, owner.token, summer),
        callSpec(handle, settingsSpecs.createSeason, owner.token, { ...summer, name: "صيف ٢" }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await handle.db.select().from(seasons)).toHaveLength(1);
    });

    it("refuses an end date before the start", async () => {
      const { owner } = await scenario();
      expect(
        await callSpec(handle, settingsSpecs.createSeason, owner.token, { ...summer, endDate: "2026-05-01" }),
      ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR", fieldErrors: { endDate: expect.any(String) } } });
    });
  });

  describe("lists: event types, payment methods, expense categories", () => {
    it("D-72: a duplicate name is refused; a duplicate of an inactive item suggests reactivating it", async () => {
      const { owner } = await scenario();
      const { id } = ok(
        await callSpec(handle, settingsSpecs.createListItem, owner.token, { kind: "paymentMethods", name: "Cash" }),
      );
      expect(
        await callSpec(handle, settingsSpecs.createListItem, owner.token, { kind: "paymentMethods", name: "cash" }),
      ).toMatchObject({
        ok: false,
        error: { code: "VALIDATION_ERROR", fieldErrors: { name: "يوجد عنصر بنفس الاسم." } },
      });
      ok(
        await callSpec(handle, settingsSpecs.setListItemActive, owner.token, {
          kind: "paymentMethods",
          id,
          active: false,
        }),
      );
      const again = await callSpec(handle, settingsSpecs.createListItem, owner.token, {
        kind: "paymentMethods",
        name: "CASH",
      });
      expect(again.ok === false && again.error.fieldErrors?.name).toContain("فعّله");
    });

    it("D-71: adds the suggested names once, the first event type being a wedding", async () => {
      const { owner } = await scenario();
      ok(await callSpec(handle, settingsSpecs.createListItem, owner.token, { kind: "eventTypes", name: "خطوبة" }));
      const first = ok(await callSpec(handle, settingsSpecs.addSuggestedItems, owner.token, { kind: "eventTypes" }));
      expect(first.added).toBe(5);
      const second = ok(await callSpec(handle, settingsSpecs.addSuggestedItems, owner.token, { kind: "eventTypes" }));
      expect(second.added).toBe(0);
      const items = await listItems(handle.db, owner.actor, "eventTypes");
      expect(items.map((i) => i.name)).toEqual(["خطوبة", "فرح", "كتب كتاب", "حنة", "عيد ميلاد", "مناسبة أخرى"]);
      expect(items.filter((i) => i.isWedding).map((i) => i.name)).toEqual(["فرح"]);
      ok(await callSpec(handle, settingsSpecs.addSuggestedItems, owner.token, { kind: "expenseCategories" }));
      expect((await listItems(handle.db, owner.actor, "expenseCategories")).length).toBe(6);
    });

    it("reorders event types and payment methods; expense categories stay by name", async () => {
      const { owner } = await scenario();
      ok(await callSpec(handle, settingsSpecs.addSuggestedItems, owner.token, { kind: "paymentMethods" }));
      const [first, second] = await listItems(handle.db, owner.actor, "paymentMethods");
      ok(
        await callSpec(handle, settingsSpecs.moveListItem, owner.token, {
          kind: "paymentMethods",
          id: second.id,
          direction: "up",
        }),
      );
      const after = await listItems(handle.db, owner.actor, "paymentMethods");
      expect(after.slice(0, 2).map((i) => i.id)).toEqual([second.id, first.id]);
      expect(await auditActions(handle)).toContain("payment_methods.reorder");
      expect(
        await callSpec(handle, settingsSpecs.moveListItem, owner.token, {
          kind: "expenseCategories",
          id: first.id,
          direction: "up",
        }),
      ).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
    });

    it("cannot touch another venue's rows (venue_id scoping)", async () => {
      const { owner } = await scenario();
      const [other] = await handle.db
        .insert(venues)
        .values({ name: "منشأة أخرى", ...VENUE_DEFAULTS })
        .returning({ id: venues.id });
      const [foreign] = await handle.db
        .insert(eventTypes)
        .values({ venueId: other.id, name: "فرح" })
        .returning({ id: eventTypes.id });
      const [foreignSpace] = await handle.db
        .insert(spaces)
        .values({ venueId: other.id, name: "قاعة" })
        .returning({ id: spaces.id });
      expect(
        await callSpec(handle, settingsSpecs.updateListItem, owner.token, {
          kind: "eventTypes",
          id: foreign.id,
          name: "x",
        }),
      ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      expect(
        await callSpec(handle, spaceSpecs.setSpaceActive, owner.token, { spaceId: foreignSpace.id, active: false }),
      ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      expect(await listItems(handle.db, owner.actor, "eventTypes")).toEqual([]);
    });
  });

  describe("UF-02: the guided checklist and booking readiness reflect the real state", () => {
    it("steps turn done as the owner configures, and back when the last space is deactivated", async () => {
      const { owner } = await scenario();
      const status = async () =>
        Object.fromEntries((await getSetupChecklist(handle.db, owner.actor)).steps.map((s) => [s.key, s.status]));
      expect(await status()).toMatchObject({
        venue: "missing",
        spaces: "missing",
        timing: "done",
        eventTypes: "missing",
        paymentMethods: "missing",
        policies: "missing",
        // The manager and the receptionist are active non-owner staff.
        staff: "done",
      });
      expect(await bookingReadiness(handle.db, owner.actor.venueId)).toEqual({
        ready: false,
        gaps: ["activeSpace", "pricedPackage", "cancellationTiers"],
      });

      ok(
        await callSpec(handle, settingsSpecs.updateVenue, owner.token, {
          name: "قاعة",
          phone: "0221234567",
          address: "القاهرة",
        }),
      );
      const { id } = ok(await callSpec(handle, spaceSpecs.createSpace, owner.token, hall));
      ok(await callSpec(handle, settingsSpecs.updatePolicies, owner.token, policies));
      ok(await callSpec(handle, settingsSpecs.addSuggestedItems, owner.token, { kind: "eventTypes" }));
      ok(await callSpec(handle, settingsSpecs.addSuggestedItems, owner.token, { kind: "paymentMethods" }));
      expect(await status()).toMatchObject({
        venue: "done",
        spaces: "done",
        eventTypes: "done",
        paymentMethods: "done",
        policies: "done",
        services: "unavailable",
        packages: "unavailable",
      });
      expect((await bookingReadiness(handle.db, owner.actor.venueId)).gaps).toEqual(["pricedPackage"]);

      ok(await callSpec(handle, spaceSpecs.setSpaceActive, owner.token, { spaceId: id, active: false }));
      expect((await status()).spaces).toBe("missing");
      expect((await bookingReadiness(handle.db, owner.actor.venueId)).gaps).toContain("activeSpace");
    });
  });

  it("every successful operation is in the audit log", async () => {
    const { owner } = await scenario();
    const { id } = ok(await callSpec(handle, spaceSpecs.createSpace, owner.token, hall));
    ok(await callSpec(handle, spaceSpecs.updateSpace, owner.token, { ...hall, spaceId: id, name: "الكبرى" }));
    ok(await callSpec(handle, spaceSpecs.setSpaceActive, owner.token, { spaceId: id, active: false }));
    ok(await callSpec(handle, settingsSpecs.updateTiming, owner.token, { bufferMinutes: 30, tentativeHoldHours: 24 }));
    ok(await callSpec(handle, settingsSpecs.updatePolicies, owner.token, policies));
    const { id: seasonId } = ok(
      await callSpec(handle, settingsSpecs.createSeason, owner.token, {
        name: "الصيف",
        startDate: "2026-06-01",
        endDate: "2026-08-31",
      }),
    );
    ok(await callSpec(handle, settingsSpecs.setSeasonActive, owner.token, { seasonId, active: false }));
    const { id: categoryId } = ok(
      await callSpec(handle, settingsSpecs.createListItem, owner.token, { kind: "expenseCategories", name: "صيانة" }),
    );
    ok(
      await callSpec(handle, settingsSpecs.updateListItem, owner.token, {
        kind: "expenseCategories",
        id: categoryId,
        name: "صيانة عامة",
      }),
    );
    expect(await auditActions(handle)).toEqual(
      expect.arrayContaining([
        "spaces.create",
        "spaces.update",
        "spaces.deactivate",
        "settings.timing_updated",
        "settings.policies_updated",
        "seasons.create",
        "seasons.deactivate",
        "expense_categories.create",
        "expense_categories.update",
      ]),
    );
  });
});
