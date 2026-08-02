// @wardenx/db — `usage_period_aggregate` (M35 §3.3). TENANT-SCOPED, RLS on app.org_id (0143). One row
// per (subscription, event_type, period). `organization_id` is a logical uuid (M35-F04); `subscription_id`
// is a REAL FK. The §3.6 posture audits only when `stripe_usage_record_id` is set (partial-exclusion).
import {
  bigint,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usageEventType } from "../../enums";
import { subscriptionRow } from "./subscription";

export const usagePeriodAggregate = pgTable(
  "usage_period_aggregate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptionRow.id, { onDelete: "restrict" }),
    eventType: usageEventType("event_type").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    totalQuantity: bigint("total_quantity", { mode: "number" }).notNull().default(0),
    inclusiveQuantity: bigint("inclusive_quantity", { mode: "number" }).notNull().default(0),
    overageQuantity: bigint("overage_quantity", { mode: "number" }).notNull().default(0),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
    stripeUsageRecordId: text("stripe_usage_record_id"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postAttemptCount: integer("post_attempt_count").notNull().default(0),
    warningEmittedAt: timestamp("warning_emitted_at", { withTimezone: true }),
    breachEmittedAt: timestamp("breach_emitted_at", { withTimezone: true }),
  },
  (t) => ({
    uniquePeriod: uniqueIndex("usage_period_aggregate_uq").on(
      t.subscriptionId,
      t.eventType,
      t.periodStart,
      t.periodEnd,
    ),
    unpostedIx: index("usage_period_aggregate_unposted_ix")
      .on(t.computedAt)
      .where(sql`stripe_usage_record_id IS NULL`),
  }),
);

export type UsagePeriodAggregateRow = typeof usagePeriodAggregate.$inferSelect;
export type NewUsagePeriodAggregateRow = typeof usagePeriodAggregate.$inferInsert;
