-- M20 Field Safety §3.4 / D4 / §7.3 (M20-T03) — widen the overdue detector's partial index to include
-- `escalated`.
--
-- WHY THIS IS A CORRECTION AND NOT A TUNING CHANGE. Migration 0110 created
-- `scis_overdue_scan_idx … WHERE state IN ('proposed','overdue')`, which mirrored the two-member
-- `SAFETY_SCHEDULE_ACTIONABLE_STATES` M20-T01 shipped. Building the D4 ladder (M20-T03) showed both were a
-- rung short of the design: §7.3 walks FOUR rungs past `expected_at` —
--
--     +5 min  gentle_reminder  → state `overdue`   , m20.safety.check_in_overdue   (warn)
--     +15 min supervisor_alert → state `escalated` , m20.safety.check_in_escalated (critical)
--     +30 min escalation       → state `escalated` , m20.safety.check_in_escalated (critical)
--     +60 min sos_equivalent   → state `escalated` , m20.safety.check_in_escalated (critical, SOS fan-out)
--
-- — and the row enters `escalated` at the SECOND rung. With the old predicate the 30-second cron's own
-- query stops matching the index (and, with the old constant, the decider stopped acting on the row at
-- all) exactly when the two most urgent rungs are still ahead: the 30-minute escalation and the 60-minute
-- SOS-equivalent, which is the rung §7.3 routes through Tier-1 voice because an unreachable clinician is
-- "a life-safety incident in waiting". A schedule leaves the actionable set only when a human resolves it —
-- `recorded`, `superseded`, `incident_opened`.
--
-- The index is dropped and recreated rather than added alongside: a partial index whose predicate no longer
-- matches the query is dead weight the planner will never choose, and leaving it would make a future reader
-- believe the scan was covered.
DROP INDEX IF EXISTS "scis_overdue_scan_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scis_overdue_scan_idx"
  ON "safety_check_in_schedule" ("organization_id","state","expected_at")
  WHERE state IN ('proposed','overdue','escalated');
