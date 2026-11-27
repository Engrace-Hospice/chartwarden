import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
// @chartwarden/db — `object_destruction_tombstone` (M22, CW-DS-01, migration 1560). The durable record that an object was destroyed:
// one row per (bucket, object key), written by the document eraser (as `chartwarden_destruction`) BEFORE it destroys the object and
// never changed (a trigger refuses UPDATE and DELETE for every role). `document_id` / `document_version_id` are plain uuids with no
// foreign key: the document rows are deleted right after and the record must outlive them. `object_key` carries the patient's opaque
// id (D11), so the audit snapshot scrubs it. The application role can only read its own tenant's rows.
import { organizations } from "../organizations";

export const objectDestructionTombstones = pgTable(
  "object_destruction_tombstone",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    bucket: text("bucket").notNull(),
    objectKey: text("object_key").notNull(),
    documentId: uuid("document_id"),
    documentVersionId: uuid("document_version_id"),
    basis: text("basis").notNull().default("patient_erasure"),
    destroyedAt: timestamp("destroyed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneRowPerObject: unique("object_destruction_tombstone_object_unique").on(
      t.organizationId,
      t.bucket,
      t.objectKey,
    ),
  }),
);

export type ObjectDestructionTombstone = typeof objectDestructionTombstones.$inferSelect;
export type NewObjectDestructionTombstone = typeof objectDestructionTombstones.$inferInsert;
