// @wardenx/db — `document_access_log` (M22 §3.3). The §164.528 disclosure-accounting ledger: one
// row per document content access (metadata read, content download, signed-URL issue/consume,
// portal view, disclosure export), written by `auditRead()`. Feeds M4's accounting-of-disclosures
// surface. Org-scoped; high-volume → cross-module FKs (document, version, accessor) are plain uuid.
//
// PARTITION BY RANGE (accessed_at) monthly: the Drizzle definition here is the LOGICAL shape
// (composite PK incl. the partition key); the PARTITION BY + monthly children + DEFAULT catch-all
// land in the RLS migration (0049), which drops the plain table 0048 emits and re-creates it
// partitioned (the M18 `evv_event` precedent). `purpose` / `recipient_class` are DENYLISTED (§3.6 —
// audit-of-audit churn, not PHI).
import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const documentAccessLog = pgTable(
  "document_access_log",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with accessed_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    documentId: uuid("document_id").notNull(),
    documentVersionId: uuid("document_version_id").notNull(),
    accessorMembershipId: uuid("accessor_membership_id").notNull(),
    accessKind: text("access_kind").notNull(), // document_access_kind value
    purpose: text("purpose").notNull(), // DENYLISTED (§3.6)
    recipientMembershipId: uuid("recipient_membership_id"),
    recipientClass: text("recipient_class"), // DENYLISTED (§3.6)
    correlationId: text("correlation_id").notNull(),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.accessedAt] }), // partition key must be in the PK
    byDocument: index("doc_access_log_doc_idx").on(t.documentId, t.accessedAt.desc()),
    byAccessor: index("doc_access_log_accessor_idx").on(
      t.organizationId,
      t.accessorMembershipId,
      t.accessedAt.desc(),
    ),
    byPurpose: index("doc_access_log_purpose_idx").on(
      t.organizationId,
      t.purpose,
      t.accessedAt.desc(),
    ),
  }),
);

export type DocumentAccessLog = typeof documentAccessLog.$inferSelect;
export type NewDocumentAccessLog = typeof documentAccessLog.$inferInsert;
