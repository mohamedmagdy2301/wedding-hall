import { sql } from "drizzle-orm";
import { check, index, integer, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { bookings } from "./bookings";
import { timestamps } from "./columns";
import { users } from "./users";
import { venues } from "./venues";

// DATA_MODEL §4 `booking_documents` (phase 9). The file lives in R2 under a random key (SEC-23);
// a removed document keeps its row and loses its file (Q9-03, trigger in 0010).

export const documentKindEnum = pgEnum("document_kind", ["national_id", "signed_contract", "other"]);

const instant = (name: string) => timestamp(name, { withTimezone: true });

export const bookingDocuments = pgTable(
  "booking_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    venueId: uuid("venue_id")
      .notNull()
      .references(() => venues.id),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id),
    kind: documentKindEnum("kind").notNull(),
    fileKey: text("file_key").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    removedAt: instant("removed_at"),
    removedBy: uuid("removed_by").references(() => users.id),
    removeReason: text("remove_reason"),
    ...timestamps,
  },
  (t) => [
    unique("booking_documents_file_key_unique").on(t.fileKey),
    index("booking_documents_booking_idx").on(t.bookingId),
    check(
      "booking_documents_mime_check",
      sql`${t.mimeType} IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')`,
    ),
    check("booking_documents_size_check", sql`${t.sizeBytes} BETWEEN 1 AND 5242880`),
    check(
      "booking_documents_remove_check",
      sql`num_nonnulls(${t.removedAt}, ${t.removedBy}, ${t.removeReason}) IN (0, 3)
        AND (${t.removeReason} IS NULL OR length(${t.removeReason}) BETWEEN 3 AND 300)`,
    ),
  ],
);
