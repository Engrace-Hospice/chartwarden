// @wardenx/db — `tenant_notification_template_overlay` (M36 Secure Messaging §3.13, ADR-0024 —
// moved from M14). A per-tenant tighten-only overlay on a `notification_template`: a tenant
// may reword title/body for brand voice (NULL = use the platform default), but cannot remove
// mandatory wording or change the payload type / recipient resolver (those stay platform-floor,
// enforced at the apply-and-render step). Org-scoped (organization_id); RLS + the M4
// write-audit trigger (operational) land in M36-T03.
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { memberships } from "../memberships";
import { organizations } from "../organizations";

export const tenantNotificationTemplateOverlay = pgTable(
  "tenant_notification_template_overlay",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    titleTemplate: text("title_template"), // null = use platform default
    bodyTemplate: text("body_template"),
    configuredByMembershipId: uuid("configured_by_membership_id")
      .notNull()
      .references(() => memberships.id),
    configuredAt: timestamp("configured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerOrgKey: uniqueIndex("tenant_notification_template_overlay_uk").on(
      t.organizationId,
      t.templateKey,
    ),
  }),
);

export type TenantNotificationTemplateOverlay =
  typeof tenantNotificationTemplateOverlay.$inferSelect;
export type NewTenantNotificationTemplateOverlay =
  typeof tenantNotificationTemplateOverlay.$inferInsert;
