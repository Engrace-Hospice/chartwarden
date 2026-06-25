// @wardenx/db — `report_metric_catalog` (M33 §3.3). The platform-global catalog of metrics: each
// row names a metric, its unit + aggregation, the source seam it derives from, an optional formula,
// and the sensitivity tier (stricter ABAC). PLATFORM-scoped: NO organization_id (retention class
// `platform`); sits on the check-tenancy NON_ORG_SCOPED allowlist. RLS + grants land in the M33 RLS
// migration.
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const reportMetricCatalog = pgTable("report_metric_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  metricKey: text("metric_key").notNull().unique(), // e.g., 'encounter_count', 'late_sign_rate_pct'
  displayName: text("display_name").notNull(),
  unit: text("unit", {
    enum: ["count", "rate_pct", "currency_cents", "minutes", "days", "ratio"],
  }).notNull(),
  aggregation: text("aggregation", {
    enum: ["sum", "avg", "count_distinct", "max", "min", "percentile"],
  }).notNull(),
  sourceSeam: text("source_seam").notNull(), // e.g., 'EncounterStatisticsProvider.aggregateForOrg'
  formula: text("formula"), // human-readable description of derivation
  sensitiveFlag: boolean("sensitive_flag").notNull().default(false), // tier with stricter ABAC
  status: text("status", {
    enum: ["seeded", "active", "deprecated", "retired"],
  })
    .notNull()
    .default("seeded"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ReportMetricCatalog = typeof reportMetricCatalog.$inferSelect;
export type NewReportMetricCatalog = typeof reportMetricCatalog.$inferInsert;
