// @wardenx/db — `notification_template` (M36 Secure Messaging §3.13, ADR-0024 — moved from
// M14). The versioned notification-copy catalog: a title/body template keyed by
// (organization_id, template_key, version), bound to a catalog `default_payload_type` and a
// default recipient resolver. A NULL organization_id row is the platform-floor template.
// Org-scoped (nullable organization_id); RLS + the M4 write-audit trigger (operational) land
// in M36-T03.
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { alertPayloadCatalog } from "./alert-payload-catalog";

export const notificationTemplate = pgTable(
  "notification_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }), // null = platform floor
    templateKey: text("template_key").notNull(),
    version: integer("version").notNull().default(1),
    titleTemplate: text("title_template").notNull(),
    bodyTemplate: text("body_template").notNull(),
    payloadSchema: jsonb("payload_schema").notNull(),
    defaultPayloadType: text("default_payload_type")
      .notNull()
      .references(() => alertPayloadCatalog.payloadType),
    defaultRecipientResolver: text("default_recipient_resolver").notNull(),
    supportedLocales: text("supported_locales").array().notNull().default(["en-US"]),
    status: text("status").notNull().default("published"),
    ownedByModule: text("owned_by_module").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // ADR-0024: keyed by (organization_id, template_key, version)
    uniqueKeyVersion: uniqueIndex("notification_template_org_key_version_uk").on(
      t.organizationId,
      t.templateKey,
      t.version,
    ),
    byKey: index("notification_template_key_idx").on(t.templateKey, t.version),
  }),
);

export type NotificationTemplate = typeof notificationTemplate.$inferSelect;
export type NewNotificationTemplate = typeof notificationTemplate.$inferInsert;
