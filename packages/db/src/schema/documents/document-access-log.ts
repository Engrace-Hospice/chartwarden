// @wardenx/db — `document_access_log` (M22 §3.3). The per-access read-audit ledger feeding M4's
// accounting-of-disclosures surface (HIPAA §164.528): one row per metadata read / content download / signed-URL
// issuance+consumption / portal view / disclosure export. Org-scoped; carries no `patient_id` column (the
// document join supplies the patient). PARTITION BY RANGE (accessed_at) monthly — the Drizzle shape here is
// logical (composite PK incl. the partition key); the PARTITION BY + monthly children + DEFAULT catch-all land
// in the RLS migration (0049). `purpose` + `recipient_class` are DENYLISTED in the §3.6 write-audit trigger
// (not PHI, but audit-of-audit churn). These rows are NOT cascade-deleted by the eraser within the §164.528
// retention floor (ADR-0013). RLS + grants + the M4 write-audit trigger land in 0049.
import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const documentAccessLog = pgTable(
  "document_access_log",
  {
    id: uuid("id").notNull().defaultRandom(), // composite PK with accessed_at (the partition key)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    documentId: uuid("document_id").notNull(), // app-validated (no FK; access log survives doc tombstone)
    documentVersionId: uuid("document_version_id").notNull(),
    accessorMembershipId: uuid("accessor_membership_id").notNull(),
    accessKind: text("access_kind").notNull(), // document_access_kind enum value (text per access-log convention)
    purpose: text("purpose").notNull(), // document_access_purpose enum value → DENYLISTED (§3.6)
    recipientMembershipId: uuid("recipient_membership_id"),
    recipientClass: text("recipient_class"), // → DENYLISTED (§3.6)
    correlationId: text("correlation_id").notNull(),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(), // partition key
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
