// @wardenx/db — `form_template` (M22 §3.3 / §4.5). The platform-published form-template catalog: one row per
// template key (globally unique — NOT per-org). Like M38 `code_system` / M39 `consent_type_catalog`, this is
// platform-shared reference data with NO organization_id BY DESIGN (dual-grant RLS: read-all within any tenant;
// writes only via the platform `form_template_writer` role — see 0049). Tenants tailor a template via
// `tenant_template_overlay`, not by writing this catalog. No PHI / no denylisted columns. RLS + grants + the M1
// baseline audit trigger land in 0049. (check-tenancy NON_ORG_SCOPED exemption is registered alongside.)
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { documentAggregateType, documentRetentionClass, formRenderEngine } from "../../enums";

export const formTemplates = pgTable(
  "form_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateKey: text("template_key").notNull(), // platform-published key (globally unique)
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
