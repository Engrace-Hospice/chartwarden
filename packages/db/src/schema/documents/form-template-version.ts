// @wardenx/db — `form_template_version` (M22 §3.3 / §2.2.3). The draft→published→deprecated version
// lifecycle of a platform form template; `payload_schema` is the serialized TypeBox render contract.
// Platform-shared reference (NO organization_id BY DESIGN, like its parent `form_template`) → listed
// in check-tenancy NON_ORG_SCOPED, dual-grant RLS in 0049. `payload_schema` is DENYLISTED in the
// audit trigger (§3.6 — structural, not PHI). `template_id` carries a SQL FK to `form_template`.
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { formTemplates } from "./form-template";

export const formTemplateVersions = pgTable(
  "form_template_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => formTemplates.id),
    versionLabel: text("version_label").notNull(), // e.g. v1.2.0
    sourcePath: text("source_path").notNull(),
    payloadSchema: jsonb("payload_schema").notNull(), // TypeBox schema serialized; DENYLISTED (§3.6)
    status: text("status").notNull().default("draft"), // draft|published|deprecated
    publishedByMembershipId: uuid("published_by_membership_id"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTemplateVersion: uniqueIndex("form_template_version_uk").on(t.templateId, t.versionLabel),
  }),
);

export type FormTemplateVersion = typeof formTemplateVersions.$inferSelect;
export type NewFormTemplateVersion = typeof formTemplateVersions.$inferInsert;
