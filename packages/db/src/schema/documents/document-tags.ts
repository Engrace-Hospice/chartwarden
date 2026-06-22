// @wardenx/db — `document_tag` (M22 §3.3). User/structured tags on a document. Org-scoped; carries no
// `patient_id` column. The one M22 table wardenx_app may DELETE from (tags are user-removable; §3.2 Phase 2).
// `tag_value` may carry PHI when tag_kind='free' → DENYLISTED in the §3.6 write-audit trigger. RLS + grants +
// the M4 write-audit trigger land in 0049.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { documents } from "./documents";

export const documentTags = pgTable(
  "document_tag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "restrict" }),
    tagKind: text("tag_kind").notNull(), // free|structured
    tagKey: text("tag_key").notNull(),
    tagValue: text("tag_value"), // may carry PHI when tag_kind='free' → DENYLISTED (§3.6)
    addedByMembershipId: uuid("added_by_membership_id").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDocument: index("document_tag_doc_idx").on(t.documentId, t.tagKey),
    byOrgKey: index("document_tag_org_key_idx").on(t.organizationId, t.tagKey, t.tagValue),
  }),
);

export type DocumentTag = typeof documentTags.$inferSelect;
export type NewDocumentTag = typeof documentTags.$inferInsert;
