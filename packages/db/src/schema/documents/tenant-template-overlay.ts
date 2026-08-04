import { sql } from "drizzle-orm";
// @wardenx/db — `tenant_template_overlay` (M22 §3.3 / §4.5 / D14). The per-tenant branding +
// state-addendum layered on top of a platform `form_template`. Org-scoped (organization_id NOT
// NULL); partial-UNIQUE `(organization_id, template_id) WHERE is_active = true` enforces at-most-one
// active overlay per (org, template). `branding` / `state_addendum` are DENYLISTED in the audit
// trigger (§3.6 — tenant-confidential). `template_id` carries a SQL FK to `form_template`.
import { boolean, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { formTemplates } from "./form-template";

export const tenantTemplateOverlays = pgTable(
  "tenant_template_overlay",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    templateId: uuid("template_id")
      .notNull()
      .references(() => formTemplates.id),
    branding: jsonb("branding").notNull(), // letterhead/logo/footer/signature-block-style; DENYLISTED (§3.6)
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
