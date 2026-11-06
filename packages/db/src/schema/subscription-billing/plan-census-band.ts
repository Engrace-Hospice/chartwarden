// @chartwarden/db — `plan_census_band` (M35, slice 2 — migration 1361). One row per census band of a census_banded plan.
// A band is a THRESHOLD: it starts at `min_adc` patients and runs until the next band starts, so bands cannot overlap or
// leave a gap. PLATFORM-SHARED (no organization_id BY DESIGN: the same offer for every tenant): read-all to chartwarden_app,
// written only by the platform carrier / chartwarden_admin. The bands of a published plan are frozen with it (guard trigger).
import { bigint, integer, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { plan } from "./plan";

export const planCensusBand = pgTable(
  "plan_census_band",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "restrict" }),
    minAdc: integer("min_adc").notNull(),
    monthlyFeeCents: bigint("monthly_fee_cents", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    planMinAdcUq: unique("plan_census_band_plan_min_adc_uq").on(t.planId, t.minAdc),
  }),
);

export type PlanCensusBandRow = typeof planCensusBand.$inferSelect;
export type NewPlanCensusBandRow = typeof planCensusBand.$inferInsert;
