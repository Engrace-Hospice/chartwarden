// @wardenx/db - per-consumer completion receipts for the M1 transactional outbox.
// A source event may have several independently deployed consumers. The dispatcher keeps the
// source row pending until every catalog-declared module is live, while this table prevents an
// already-completed binding from being replayed on every deferred poll or process restart.
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { outboxEvents } from "./outbox-events";

export const outboxConsumerReceipts = pgTable(
  "outbox_consumer_receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => outboxEvents.id, { onDelete: "cascade" }),
    consumerName: text("consumer_name").notNull(),
    consumerModule: text("consumer_module").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    eventConsumerUnique: uniqueIndex("outbox_consumer_receipt_event_consumer_uq").on(
      t.eventId,
      t.consumerName,
    ),
    orgCompletedIdx: index("outbox_consumer_receipt_org_completed_idx").on(
      t.organizationId,
      t.completedAt,
    ),
  }),
);

export type OutboxConsumerReceipt = typeof outboxConsumerReceipts.$inferSelect;
export type NewOutboxConsumerReceipt = typeof outboxConsumerReceipts.$inferInsert;
