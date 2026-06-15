// @wardenx/db — `outbox_event` (M1 Foundation §3.10). The transactional outbox for
// reliable cross-module event publication (mN.<resource>.<verb>). HELPER-ONLY:
// written exclusively by the packages/shared outbox dispatcher — never a direct
// insert/select from a feature module (HELPER_ONLY_TABLES, manifest). org-scoped:
// carries organization_id (no PHI columns → three-column PE/location not required).
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { outboxEventStatus } from "../enums";
import { organizations } from "./organizations";

export const outboxEvents = pgTable(
  "outbox_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    aggregateKind: text("aggregate_kind").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").notNull(),
    status: outboxEventStatus("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (t) => ({
    statusCreatedIdx: index("outbox_status_created_idx").on(t.status, t.createdAt),
    orgIdx: index("outbox_org_idx").on(t.organizationId),
  }),
);

export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type NewOutboxEvent = typeof outboxEvents.$inferInsert;
