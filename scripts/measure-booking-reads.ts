import { neonConfig, Pool } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/neon-serverless";
import { REQUEST_MAX_CONNECTIONS } from "../src/db/client";
import * as schema from "../src/db/schema";
import { packages, users } from "../src/db/schema";
import { addDays, cairoDate } from "../src/lib/time";
import { createSession } from "../src/modules/auth/sessions";
import { runProtected } from "../src/server/action-core";
import { availabilitySpecs } from "../src/server/specs/bookings";
import { pricingSpecs } from "../src/server/specs/pricing";
import { requireEnv } from "./lib/load-env";

/**
 * Development measurement (phase 5 report §4.7): how long `pricing.quote` and
 * `availability.check` take through the whole action pipeline, how many queries they run
 * and how long each takes. Run it against a local seeded database (`db:seed`), never a
 * venue's: DATABASE_URL=… NEON_LOCAL_WSPROXY=… npx tsx scripts/measure-booking-reads.ts
 * Prints timings and SQL shapes only (no values, no secrets).
 */

type Timing = { sql: string; ms: number };

function instrumentedDb(
  timings: Timing[],
  max = Number(process.env.MEASURE_MAX_CONNECTIONS) || REQUEST_MAX_CONNECTIONS,
) {
  const proxy = process.env.NEON_LOCAL_WSPROXY;
  if (proxy) {
    neonConfig.wsProxy = () => `${proxy}/v1`;
    neonConfig.useSecureWebSocket = false;
    neonConfig.pipelineTLS = false;
    neonConfig.pipelineConnect = false;
  }
  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL"), max });
  pool.on("error", () => {});
  const original = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
    const started = performance.now();
    try {
      return await original(...args);
    } finally {
      const first = args[0] as string | { text: string };
      const text = typeof first === "string" ? first : first.text;
      timings.push({ sql: text.replace(/\s+/g, " ").slice(0, 90), ms: performance.now() - started });
    }
  };
  return { db: drizzle({ client: pool, schema }), close: () => pool.end() };
}

async function main() {
  const setup = instrumentedDb([]);
  const [owner] = await setup.db.select({ id: users.id }).from(users).where(eq(users.login, "owner"));
  const [pkg] = await setup.db
    .select({ id: packages.id, spaceId: packages.spaceId })
    .from(packages)
    .where(eq(packages.name, "الباكيج الذهبي"));
  const { token } = await createSession(setup.db, owner.id, new Date());
  await setup.close();

  const eventDate = addDays(cairoDate(new Date()), 40);
  const quoteInput = { spaceId: pkg.spaceId, packageId: pkg.id, slotKind: "evening", eventDate, guests: "450" };
  const checkInput = { spaceId: pkg.spaceId, eventDate, slotKind: "evening" };

  async function run(label: string, spec: unknown, input: unknown, runs: number) {
    const totals: number[] = [];
    let last: Timing[] = [];
    for (let i = 0; i < runs; i += 1) {
      const timings: Timing[] = [];
      // A new pool per call, like one request (src/db/request.ts).
      const { db, close } = instrumentedDb(timings);
      const started = performance.now();
      const s = spec as typeof pricingSpecs.quote;
      const result = await runProtected(
        { db, hasher: undefined as never, now: new Date(), sessionToken: token, requestMeta: {} },
        s,
        s.handler,
        input,
      );
      totals.push(performance.now() - started);
      if (!result.ok) throw new Error(`${label}: ${result.error.code}`);
      await close();
      last = timings;
    }
    const sorted = [...totals].sort((a, b) => a - b);
    console.log(
      `\n${label}: median ${sorted[Math.floor(runs / 2)].toFixed(0)} ms, min ${sorted[0].toFixed(0)}, max ${sorted[runs - 1].toFixed(0)} — ${last.length} queries (last run):`,
    );
    for (const t of last) console.log(`  ${t.ms.toFixed(0).padStart(5)} ms  ${t.sql}`);
  }

  await run("pricing.quote", pricingSpecs.quote, quoteInput, 15);
  await run("availability.check", availabilitySpecs.check, checkInput, 15);
}

main().catch((error: unknown) => {
  console.error("Failed:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
