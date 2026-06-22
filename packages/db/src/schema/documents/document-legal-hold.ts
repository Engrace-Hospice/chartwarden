// @wardenx/db — `document_legal_hold` (M22 §3.3 / §2.2.3). Per-document legal-hold record; at most one active
// hold per document (partial-UNIQUE WHERE released_at IS NULL). Applied/released by the M4 legal-hold workflow
// (`m4.legal_hold.applied`/`released` consumers). While a document has an active hold its `status` is
// `legal_hold` and the eraser refuses destruction. Org-scoped; carries no `patient_id` column; no denylisted
// columns. RLS + grants + the M4 write-audit trigger land in 0049.
import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../organizations";
import { documents } from "./documents";

export const documentLegalHold = pgTable(
  "document_legal_hold",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    legalHoldEventId: uuid("legal_hold_event_id").notNull(), // M4 legal_hold row (app-validated)
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
