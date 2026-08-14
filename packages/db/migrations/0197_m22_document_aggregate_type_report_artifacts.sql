-- GAP-051 — the two `document_aggregate_type` values M33's render artifacts need.
--
-- M33 has named both of these since it landed: `M33_EXPORT_AGGREGATE_TYPE = "report_export"` (the ad-hoc
-- "export now" route path) and `M33_SCHEDULED_REPORT_AGGREGATE_TYPE = "report_schedule_run"` (the cron
-- path, which `packages/reporting/src/scheduled/delivery.ts` already keys its back-ref consumer on).
-- Neither existed as an enum value, so M22 could not have filed either document even once its consumer
-- was bound. Same shape as mig 0196 (M21's two supply artifacts).
--
-- `report_schedule_run` deliberately mirrors M33's own table name: the rendered PDF/XLSX belongs to the
-- OCCURRENCE, not the schedule — a weekly report renders a new document every week, and the `document_id`
-- back-ref column lives on `report_schedule_run`.
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'report_export';--> statement-breakpoint
ALTER TYPE "public"."document_aggregate_type" ADD VALUE IF NOT EXISTS 'report_schedule_run';
