// @chartwarden/db — `tenant_alert_routing_override` (M36 Secure Messaging §3.11). A tenant's
// add-only override on a catalog payload type: extra channels/recipients and an OPTIONAL
// severity escalation (tighten-only, D11 — the floor in `alert_payload_catalog` can be raised
// but never lowered, enforced at the dispatch step). Org-scoped (organization_id); RLS + the
// M4 write-audit trigger land in M36-T03.
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { alertPayloadSeverity } from "../../enums";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { alertPayloadCatalog } from "./alert-payload-catalog";

export const tenantAlertRoutingOverride = pgTable("tenant_alert_routing_override", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  payloadType: text("payload_type")
    .notNull()
    .references(() => alertPayloadCatalog.payloadType),
  addedChannels: text("added_channels").array().notNull().default([]),
  addedRecipients: jsonb("added_recipients").notNull().default([]),
  escalatedSeverity: alertPayloadSeverity("escalated_severity"),
  rationale: text("rationale").notNull(),
  configuredByMembershipId: uuid("configured_by_membership_id")
    .notNull()
    .references(() => memberships.id),
  configuredAt: timestamp("configured_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TenantAlertRoutingOverride = typeof tenantAlertRoutingOverride.$inferSelect;
export type NewTenantAlertRoutingOverride = typeof tenantAlertRoutingOverride.$inferInsert;
