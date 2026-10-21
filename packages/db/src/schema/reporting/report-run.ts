// @chartwarden/db — `report_run` (M33 §3.3). The MV-refresh run ledger: one row per refresh of a
// `report_mv` materialized view, with the trigger kind (nightly cron / incremental outbox / on-
// demand / manual), the originating outbox event id, duration/rows telemetry, status, and retry
// attempt. organization_id is NULLABLE — cross-tenant platform-wide refreshes (rare) carry no org.
// PARTITION BY RANGE (started_at) monthly (retention class `operational`): the Drizzle definition
// here is the LOGICAL shape — composite PK (id, started_at) including the partition key (check-ddl-
// legality Rule 1); the PARTITION BY + monthly children + DEFAULT catch-all land in the M33 RLS
// migration (the EVV `0047` precedent). `mv_key` refs materialized_view_metadata; the trigger outbox
// event id is plain uuid app-validated. RLS + grants + the M4 write-audit trigger also land in that
// migration. NB nullable organization_id: this table's RLS uses the platform-read pattern (§3.5).
import { sql } from "drizzle-orm";
import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { materializedViewMetadata } from "./materialized-view-metadata";

export const reportRun = pgTable(
  "report_run",
  {
    id: uuid("id").notNull(), // composite PK with started_at (the partition key)
    mvKey: text("mv_key")
      .notNull()
      .references(() => materializedViewMetadata.mvKey),
    organizationId: uuid("organization_id"), // nullable for cross-tenant platform-wide refreshes (rare)
    triggerKind: text("trigger_kind", {
      enum: ["nightly_cron", "incremental_outbox", "on_demand", "manual"],
    }).notNull(),
    triggerOutboxEventId: uuid("trigger_outbox_event_id"), // populated when triggerKind='incremental_outbox'
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    rowsAffected: integer("rows_affected"),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed"] })
      .notNull()
      .default("queued"),
    failureReason: text("failure_reason"),
    retryAttempt: integer("retry_attempt").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.id, t.startedAt] }), // partition key must be in the PK
    // §3.4: the "last refresh for MV" lookup (started_at desc in the migration).
    mvKeyStatusStarted: index("report_run_mv_key_status_started_idx").on(
      t.mvKey,
      t.status,
      t.startedAt,
    ),
    // §3.4: the failure-worklist (partial WHERE status='failed').
    statusStarted: index("report_run_status_started_idx")
      .on(t.status, t.startedAt)
      .where(sql`${t.status} = 'failed'`),
  }),
);

export type ReportRun = typeof reportRun.$inferSelect;
export type NewReportRun = typeof reportRun.$inferInsert;
