// @chartwarden/db — `outbox_event_catalog` (M1 Foundation §3.12 / D8). Platform-shared
// registry of every published outbox event, mirroring M4's audit_action_catalog. M1
// boot UPSERTs each registered event here (M1-T08); the outbox publisher validates
// that an event name is catalogued, the actor owns its `mN.` prefix, and the payload
// matches the registered schema (refuse-on-failure). NON_ORG_SCOPED in
// check-tenancy.ts — platform reference data, written via the platform role.
import { boolean, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const outboxEventCatalog = pgTable("outbox_event_catalog", {
  eventName: text("event_name").primaryKey(),
  moduleOwner: text("module_owner").notNull(),
  description: text("description").notNull(),
  payloadSchema: jsonb("payload_schema").notNull(),
  declaredConsumers: text("declared_consumers").array().notNull().default([]),
  isOutboxOnly: boolean("is_outbox_only").notNull().default(true),
  registeredAt: timestamp("registered_at").notNull().defaultNow(),
});

export type OutboxEventCatalogEntry = typeof outboxEventCatalog.$inferSelect;
export type NewOutboxEventCatalogEntry = typeof outboxEventCatalog.$inferInsert;
