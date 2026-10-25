// @chartwarden/db - M23 / #793 (migration 1273): the DDE provider's daily-change-report poll position per
// (provider entity, vendor, usage, operator) and the bounded record of change events the ingest did not apply.
// Opaque vendor tokens and counters only: no PHI, no MBI. `usage` / `kind` are text + CHECK.
import { bigint, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const ddeChangeCursor = pgTable(
  "dde_change_cursor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    vendor: text("vendor").notNull(),
    usage: text("usage").notNull(),
    operatorMembershipId: uuid("operator_membership_id").notNull(),
    cursor: text("cursor"),
    version: bigint("version", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("dde_change_cursor_key").on(
      t.organizationId,
      t.providerEntityId,
      t.vendor,
      t.usage,
      t.operatorMembershipId,
    ),
  ],
);

export const ddeChangeException = pgTable(
  "dde_change_exception",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(),
    vendor: text("vendor").notNull(),
    usage: text("usage").notNull(),
    eventId: text("event_id").notNull(),
    kind: text("kind").notNull(),
    seenCount: integer("seen_count").notNull().default(1),
    reasonCode: text("reason_code").notNull(),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("dde_change_exception_key").on(
      t.organizationId,
      t.providerEntityId,
      t.vendor,
      t.usage,
      t.eventId,
    ),
  ],
);
