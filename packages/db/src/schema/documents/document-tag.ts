// @chartwarden/db — `document_tag` (M22 §3.3). User/structured tags on a document. The one table
// `chartwarden_app` may DELETE (tags are user-removable, §3.2 Phase 2.3). Org-scoped; `tag_value` is
// DENYLISTED when `tag_kind='free'` (may carry PHI, §3.6 — row-conditional in the trigger).
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { documents } from "./document";

export const documentTags = pgTable(
  "document_tag",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    tagKind: text("tag_kind").notNull(), // free|structured
    tagKey: text("tag_key").notNull(),
    tagValue: text("tag_value"), // DENYLISTED when tag_kind='free' (§3.6)
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
