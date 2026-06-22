// @wardenx/db — `tenant_template_overlay` (M22 §3.3 / §4.5 D16). Per-tenant branding + state-addendum overlay
// bound to a platform `form_template`; at most one active overlay per (org, template). Org-scoped
// configuration data; carries no `patient_id` column. `branding` + `state_addendum` are tenant-confidential →
// DENYLISTED in the §3.6 write-audit trigger. The D16 golden-template-diff CHECK helper (overlay is a strict
// superset of the platform-floor mandatory fields) is installed as a function in 0049. RLS + grants + the M4
// write-audit trigger land in 0049.
import { boolean, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations } from "../organizations";
import { formTemplates } from "./form-templates";

export const tenantTemplateOverlays = pgTable(
  "tenant_template_overlay",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => formTemplates.id, { onDelete: "restrict" }),
    // letterhead, logo_url, footer_text, signature_block_style; tenant-confidential → DENYLISTED (§3.6)
    branding: jsonb("branding").notNull(),
    stateAddendum: jsonb("state_addendum"), // per-state addendum text; DENYLISTED (§3.6)
    isActive: boolean("is_active").notNull().default(true),
    publishedByMembershipId: uuid("published_by_membership_id").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneActivePerOrgTemplate: uniqueIndex("tenant_overlay_active_uk")
      .on(t.organizationId, t.templateId)
      .where(sql`is_active = true`),
  }),
);

export type TenantTemplateOverlay = typeof tenantTemplateOverlays.$inferSelect;
export type NewTenantTemplateOverlay = typeof tenantTemplateOverlays.$inferInsert;
