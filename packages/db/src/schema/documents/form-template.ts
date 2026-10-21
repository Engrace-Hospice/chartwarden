// @chartwarden/db — `form_template` (M22 §3.3 / §4.5). The platform-published form-template library
// catalog (one row per template key — election statement, CTI, NOMNC, ABN, …). Platform-shared
// reference data: NO organization_id BY DESIGN (the same template definition for every tenant; per-
// tenant branding is layered via `tenant_template_overlay`). Listed in check-tenancy NON_ORG_SCOPED;
// gets dual-grant RLS (platform writes, read-all within any tenant) in 0049 (M38 code_system / M40
// canonical-entity precedent). `publishedActiveVersionId` is a deferred ref to form_template_version
// (plain uuid, no FK, avoids the cycle with form_template_version.template_id).
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { documentAggregateType, documentRetentionClass, formRenderEngine } from "../../enums";

export const formTemplates = pgTable(
  "form_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateKey: text("template_key").notNull(), // platform-published key
    aggregateType: documentAggregateType("aggregate_type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    renderEngine: formRenderEngine("render_engine").notNull(),
    retentionClass: documentRetentionClass("retention_class").notNull(),
    patientFacing: boolean("patient_facing").notNull().default(false),
    publishedActiveVersionId: uuid("published_active_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byKey: uniqueIndex("form_template_key_uk").on(t.templateKey),
  }),
);

export type FormTemplate = typeof formTemplates.$inferSelect;
export type NewFormTemplate = typeof formTemplates.$inferInsert;
