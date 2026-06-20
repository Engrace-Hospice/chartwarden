// @wardenx/db — `alert_payload_catalog` (M36 Secure Messaging §3.11, M36-F06b). The
// platform-floor registry of typed alert payloads: each `payload_type` declares its owning
// module, the floor severity (the DISTINCT `alert_payload_severity` ladder — tenants may
// TIGHTEN but never loosen, D11), default channels + recipient resolver, and a JSON Schema.
// It is platform reference data populated at boot from the per-module contribution files
// (§3.12 Foundation Registry); it carries no organization_id and is opted out of the
// three-column rule via the check-tenancy NON_ORG_SCOPED allowlist. RLS (read-all) lands in
// M36-T03.
import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { alertPayloadSeverity } from "../../enums";

export const alertPayloadCatalog = pgTable("alert_payload_catalog", {
  payloadType: text("payload_type").primaryKey(),
  moduleOwner: text("module_owner").notNull(),
  severity: alertPayloadSeverity("severity").notNull(),
  defaultChannels: text("default_channels").array().notNull(),
  defaultRecipientResolver: text("default_recipient_resolver").notNull(),
  payloadSchema: jsonb("payload_schema").notNull(),
  requiresResponseTracking: boolean("requires_response_tracking").notNull().default(false),
  description: text("description").notNull(),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AlertPayloadCatalog = typeof alertPayloadCatalog.$inferSelect;
export type NewAlertPayloadCatalog = typeof alertPayloadCatalog.$inferInsert;
