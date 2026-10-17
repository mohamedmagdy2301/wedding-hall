import { Client } from "pg";
import { requireEnv } from "./lib/load-env";

// Prints non-secret facts about the configured database: versions and object names only.
async function main() {
  const client = new Client({ connectionString: requireEnv("DATABASE_URL_UNPOOLED", "DATABASE_URL") });
  await client.connect();
  try {
    const version = await client.query<{ v: string }>("select current_setting('server_version') as v");
    const databases = await client.query<{ datname: string }>(
      "select datname from pg_database where not datistemplate order by 1",
    );
    const extensions = await client.query<{ extname: string; extversion: string }>(
      "select extname, extversion from pg_extension order by 1",
    );
    const tables = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    console.log("server:     ", version.rows[0].v);
    console.log("databases:  ", databases.rows.map((r) => r.datname).join(", "));
    console.log("extensions: ", extensions.rows.map((r) => `${r.extname} ${r.extversion}`).join(", "));
    console.log("tables:     ", tables.rows.map((r) => r.table_name).join(", ") || "(none)");
    // Row counts only (no data) for the tables setup cares about.
    const names = new Set(tables.rows.map((r) => r.table_name));
    for (const table of ["venues", "users", "roles"].filter((t) => names.has(t))) {
      const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from ${table}`);
      console.log(`rows ${table}:`.padEnd(13), rows[0].n);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error("db:info failed:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
