import { defineConfig } from "drizzle-kit";

// Used for `db:generate` only. Migrations are applied by scripts/migrate.ts.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  strict: true,
});
