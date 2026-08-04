// @wardenx/db — `measure_recompute_queue` (M30 §3.3; non-partitioned; retention class `operational`).
// The debounced recompute work list: one pending row per (measure, provider_entity, period) flips
// requires_recompute=true on a triggering domain event (or cron) and is cleared by the recompute
// worker. ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS). provider_entity_id is a
// logical FK to M40 (plain uuid). No PHI; no audit denylist.
import { sql } from "drizzle-orm";
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const measureRecomputeQueue = pgTable(
  "measure_recompute_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    measureCode: text("measure_code").notNull(),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK to M40
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    requiresRecompute: boolean("requires_recompute").notNull().default(true),
    triggeringEventOutboxId: uuid("triggering_event_outbox_id"), // nullable for cron-scheduled
    triggeringEventName: text("triggering_event_name"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (t) => ({
    uniqPending: uniqueIndex("uq_measure_recompute_pending")
      .on(t.measureCode, t.providerEntityId, t.periodStart, t.periodEnd)
      .where(sql`requires_recompute = true`),
  }),
);

export type MeasureRecomputeQueue = typeof measureRecomputeQueue.$inferSelect;
export type NewMeasureRecomputeQueue = typeof measureRecomputeQueue.$inferInsert;
