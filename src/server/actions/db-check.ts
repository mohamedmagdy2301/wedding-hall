"use server";

import { getDb } from "@/db/request";
import { getDatabaseTime, getVenueSummary } from "@/modules/settings/repository";

export type DbCheckState =
  { status: "idle" } | { status: "ok"; serverTime: string; venueName: string | null } | { status: "error" };

/**
 * Phase 0 spike (A-02): a Server Action that reads from the database.
 * Temporary and unauthenticated by design; removed in phase 1 when the
 * session → Zod → permission → service pipeline exists (CLAUDE.md rule 6).
 */
export async function checkDatabase(): Promise<DbCheckState> {
  try {
    const db = getDb();
    const [serverTime, venue] = await Promise.all([getDatabaseTime(db), getVenueSummary(db)]);
    return { status: "ok", serverTime: serverTime.toISOString(), venueName: venue?.name ?? null };
  } catch (error) {
    console.error("db-check failed", error instanceof Error ? error.message : "unknown error");
    return { status: "error" };
  }
}
