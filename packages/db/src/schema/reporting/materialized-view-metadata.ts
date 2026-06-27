// @wardenx/db — `materialized_view_metadata` (M33 §3.3). The platform-global registry of the
// `report_mv.*` materialized views: refresh strategy, debounce window, MV dependency DAG, the
// outbox topics each MV subscribes to, the freshness SLO, and the last-refresh telemetry.
// PLATFORM-scoped: NO organization_id (retention class `platform`, immutable except by migration);
// it sits on the check-tenancy NON_ORG_SCOPED allowlist. The actual `report_mv` materialized views
// are raw `CREATE MATERIALIZED VIEW` SQL in the migration (invisible to ownership/orphan checks),
// not Drizzle tables. RLS + grants land in the M33 RLS migration.
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const materializedViewMetadata = pgTable("materialized_view_metadata", {
  id: uuid("id").primaryKey().defaultRandom(),
  mvKey: text("mv_key").notNull().unique(), // e.g., 'mv_encounter_productivity_membership_day'
  schemaName: text("schema_name").notNull().default("report_mv"),
  refreshStrategy: text("refresh_strategy", {
    enum: ["nightly", "incremental", "on_demand"],
  }).notNull(),
  debounceWindowSeconds: integer("debounce_window_seconds").notNull().default(5),
  dependsOnMvKeys: jsonb("depends_on_mv_keys").notNull().$type<string[]>().default([]),
  outboxTopicsSubscribed: jsonb("outbox_topics_subscribed").notNull().$type<string[]>().default([]),
  expectedFreshnessSeconds: integer("expected_freshness_seconds").notNull(), // SLO: replica + refresh combined
  status: text("status", {
    enum: ["registered", "active", "suspended", "retired"],
  })
    .notNull()
    .default("registered"),
  lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
  lastRefreshDurationMs: integer("last_refresh_duration_ms"),
  refreshFailureCount: integer("refresh_failure_count").notNull().default(0),
});

export type MaterializedViewMetadata = typeof materializedViewMetadata.$inferSelect;
export type NewMaterializedViewMetadata = typeof materializedViewMetadata.$inferInsert;
