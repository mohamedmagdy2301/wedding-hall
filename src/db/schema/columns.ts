import { timestamp } from "drizzle-orm/pg-core";

/** `created_at` / `updated_at` of every table (DATA_MODEL conventions). */
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};
