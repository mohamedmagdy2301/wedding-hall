import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { venues } from "@/db/schema";
import { getDatabaseTime, getVenueSummary } from "@/modules/settings/repository";
import { connectTestDb, truncateAll } from "./helpers/db";
import { PG_CHECK_VIOLATION, pgErrorCode } from "./helpers/pg-error";

const venueInput = {
  name: "قاعة الاختبار",
  bufferMinutes: 60,
  tentativeHoldHours: 48,
  minDepositType: "none",
  minDepositValue: 0,
  cancellationBasis: "deposit",
  postponeCreditMode: "refund",
} as const;

describe("settings repository", () => {
  const handle = connectTestDb();
  beforeEach(() => truncateAll(handle));
  afterAll(() => handle.close());

  it("returns null when the venue is not set up yet", async () => {
    expect(await getVenueSummary(handle.db)).toBeNull();
  });

  it("returns the deployment's venue with a generated uuid and Cairo defaults", async () => {
    await handle.db.insert(venues).values(venueInput);
    const summary = await getVenueSummary(handle.db);
    expect(summary?.name).toBe("قاعة الاختبار");
    expect(summary?.id).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await handle.db.select().from(venues);
    expect(row.timezone).toBe("Africa/Cairo");
    expect(row.currency).toBe("EGP");
  });

  it("reads the database clock", async () => {
    const now = await getDatabaseTime(handle.db);
    expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it.each([
    ["negative buffer", { bufferMinutes: -1 }],
    ["non-positive tentative hold", { tentativeHoldHours: 0 }],
    ["percent deposit above 100%", { minDepositType: "percent", minDepositValue: 10_001 }],
  ] as const)("rejects %s at the database level", async (_label, override) => {
    const error = await handle.db
      .insert(venues)
      .values({ ...venueInput, ...override })
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe(PG_CHECK_VIOLATION);
  });
});
