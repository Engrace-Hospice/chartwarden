// @chartwarden/db — `alert_rule` (M36 Secure Messaging §3.6). The per-tenant routing layer beneath
// the catalog-validated dispatch path (M36-F06a): for a given event type it sets the severity
// floor, the named recipient resolver (+ args), and an optional channel override. A NULL
// organization_id is a platform-default rule (seeded in M36-T05, §3.10); `system_locked` rules
// are tighten-only for tenants (§7.4; GAP-102 trigger, migration 0334). RLS + the M4 write-audit trigger land in M36-T03.
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { alertCategory, alertRecipientResolver, alertSeverity } from "../../enums";
import { organizations } from "../organizations";

export const alertRules = pgTable(
  "alert_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }), // null = platform default
    eventType: text("event_type").notNull(), // e.g. 'm10.hope.sfv_created'
    category: alertCategory("category").notNull(),
    severityFloor: alertSeverity("severity_floor").notNull(),
    recipientResolver: alertRecipientResolver("recipient_resolver").notNull(),
    resolverArgs: jsonb("resolver_args").notNull().default({}), // { disciplines?, roleKeys?, ... }
    channelsOverride: text("channels_override").array(), // null = use recipient preferences
    systemLocked: boolean("system_locked").notNull().default(false), // cannot be disabled
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byEvent: index("alert_rule_event_idx").on(t.eventType),
    byOrgEvent: index("alert_rule_org_event_idx").on(t.organizationId, t.eventType, t.enabled),
    uniquePerOrgEvent: uniqueIndex("alert_rule_unique").on(
      t.organizationId,
      t.eventType,
      t.severityFloor,
    ),
  }),
);

export type AlertRule = typeof alertRules.$inferSelect;
export type NewAlertRule = typeof alertRules.$inferInsert;
