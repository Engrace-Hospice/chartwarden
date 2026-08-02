// @wardenx/db — `plan_meter` (M35 §3.3). One row per (plan_id, event_type) metered dimension.
// PLATFORM-SHARED (no organization_id) — read-all, platform-only write. `plan_id` is a REAL FK to `plan`.
import {
  bigint,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { usageEventType } from "../../enums";
import { plan } from "./plan";

export const planMeter = pgTable(
  "plan_meter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "restrict" }),
    eventType: usageEventType("event_type").notNull(),
    inclusiveQuantity: bigint("inclusive_quantity", { mode: "number" }).notNull().default(0),
    overageUnitPriceCents: bigint("overage_unit_price_cents", { mode: "number" }).notNull(),
    billingAggregation: text("billing_aggregation").notNull(),
    stripeMeterId: text("stripe_meter_id"),
    warningThresholdPercent: integer("warning_threshold_percent").notNull().default(80),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planEventUq: uniqueIndex("plan_meter_plan_event_uq").on(t.planId, t.eventType),
  }),
);

export type PlanMeterRow = typeof planMeter.$inferSelect;
export type NewPlanMeterRow = typeof planMeter.$inferInsert;
