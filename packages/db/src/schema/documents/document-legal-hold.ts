import { sql } from "drizzle-orm";
// @chartwarden/db — `document_legal_hold` (M22 §3.3). The per-document legal-hold ledger: an active
// hold (released_at IS NULL) blocks destruction (the eraser skips status='legal_hold' docs, §3.7).
// Org-scoped; partial-UNIQUE `(document_id) WHERE released_at IS NULL` enforces at-most-one active
// hold per document. `legal_hold_event_id` is plain uuid app-validated (M4 legal-hold event).
import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { documents } from "./document";

export const documentLegalHold = pgTable(
  "document_legal_hold",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    legalHoldEventId: uuid("legal_hold_event_id").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => ({
    oneActivePerDoc: uniqueIndex("doc_legal_hold_active_uk")
      .on(t.documentId)
      .where(sql`released_at IS NULL`),
  }),
);

export type DocumentLegalHold = typeof documentLegalHold.$inferSelect;
export type NewDocumentLegalHold = typeof documentLegalHold.$inferInsert;
