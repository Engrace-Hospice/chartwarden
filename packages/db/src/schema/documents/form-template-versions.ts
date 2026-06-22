// @wardenx/db — `form_template_version` (M22 §3.3 / §4.5). Versioned definitions of a `form_template`: the
// react-pdf/Puppeteer source path + the serialized TypeBox payload schema. Platform-shared reference data with
// NO organization_id BY DESIGN (same dual-grant posture as `form_template`). `payload_schema` is DENYLISTED in
// §3.6 (structural, not PHI). RLS + grants + the M1 baseline audit trigger land in 0049.
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { formTemplates } from "./form-templates";

export const formTemplateVersions = pgTable(
  "form_template_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => formTemplates.id, { onDelete: "restrict" }),
    versionLabel: text("version_label").notNull(), // e.g. v1.2.0
    sourcePath: text("source_path").notNull(),
    payloadSchema: jsonb("payload_schema").notNull(), // serialized TypeBox schema; DENYLISTED (§3.6)
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
