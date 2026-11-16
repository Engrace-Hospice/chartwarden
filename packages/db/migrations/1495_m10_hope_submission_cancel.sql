-- compat: expand
-- M10 HOPE (R-08) - cancel an iQIES package that was generated but never uploaded, so a lost package no longer locks
-- its signed assessments (they are packaged again in a NEW batch). Additive only: two enum values, three nullable
-- columns and two CHECK constraints on one of them. The new status is written only by POST /hope/submissions/:id/cancel.
-- Declared `expand` on purpose (blocking an automatic restore of the previous release for a rare operator action is the
-- worse trade), but the previous release is NOT fully cancel-aware, so an operator must not roll back while a cancelled
-- batch exists: it lacks the cancelled-download guard (it would stream a cancelled zip, and only writes `exported` when the
-- status is `packaged`), it labels a result import against a cancelled batch M10_SUBMISSION_RESULT_ALREADY_RECORDED, it
-- answers mark-uploaded on one with a generic 409 CONFLICT, and it labels a rejected item whose correction sits in a
-- cancelled batch "resubmitted". None of that corrupts data; the cancelled rows simply read as an unknown status string.
-- ALTER TYPE ... ADD VALUE is safe in the migration transaction only because nothing in this file uses the new values
-- (the 1485 / 1423 precedent): the consistency CHECK below compares `status::text`, never the enum label. The partial
-- unique index `uniq_hope_sub_item_assessment_active` is `WHERE item_status = 'pending'`, so a cancelled item leaves it
-- without any index change.
-- `cancel_reason_code` is a fixed code list (mirrors HOPE_SUBMISSION_CANCEL_REASON_CODES in packages/types/src/hope.ts),
-- never free text, so the write-audit trigger needs no scrub entry.
-- Both CHECKs are inline on the new column, which is what keeps this file `expand` (a standalone DROP CONSTRAINT +
-- ADD CONSTRAINT is what arch:migration-compat reads as `contract`) and, with IF NOT EXISTS, safe to replay. Replay was
-- verified on PostgreSQL 18.6 (the production image) by running this file twice inside BEGIN/COMMIT with
-- `psql -v ON_ERROR_STOP=1` against a table that already had the columns: both runs succeeded, each printed
-- NOTICE "column ... already exists, skipping" for every ADD COLUMN, and exactly two CHECK constraints remained. The
-- observed behaviour is that an inline constraint is skipped together with its already-existing column; that is a
-- server behaviour this file relies on, not something it re-implements, so a different major version should repeat the
-- experiment. Neither CHECK can be violated by anything the previous release writes (it never sets the new columns),
-- except a stale download racing a cancel: the previous release's `UPDATE ... SET status = 'exported'` carries no status
-- guard of its own, so run against a batch a cancel has just committed it would overwrite `cancelled` while the three
-- provenance columns stay set; that write fails closed on `hope_submission_cancelled_provenance_check` (23514) and rolls
-- back, so a cancelled batch is never resurrected. Every existing row (status never 'cancelled', all three columns NULL)
-- satisfies both CHECKs.
-- `hope_submission_cancelled_provenance_check` is true all-or-none, in both directions: a `cancelled` batch has who,
-- when and why all recorded (3 non-null), and every other batch has none of them (0 non-null), so a half-filled
-- provenance (a reason code on a packaged batch, say) is refused too. It is written with num_nonnulls() and a CASE
-- rather than three `IS NOT NULL` tests because arch:migration-compat's text heuristic reads any NOT NULL inside an
-- ADD COLUMN clause as a NOT NULL column without a default, which these three nullable columns are not.
-- Two indexes for the watchdogs' alert replay (the SFV and window watchdogs re-plan their alerts every tick from the SFVs
-- `missed` and the schedules `expired` since a cutoff, `WHERE organization_id = $1 AND status = $2 AND updated_at >= $3`):
-- the existing indexes are (organization_id, status, due_at) and (organization_id, status, window_closes_at), so without
-- these the replay scans every terminal row of the org on every 15-minute tick. Plain `CREATE INDEX IF NOT EXISTS` on the
-- two (unpartitioned) tables keeps this file `expand` and replay-safe; both are mirrored in packages/db/src/schema/hope.
-- Retention note (not changed here): bootstrap/erasers/registry.ts says hope_submission envelope content is purged by
-- M4's MinIO worker. That does not hold for the `db://` manual packages this module builds: the ZIP lives in
-- `hope_submission.acceptance_report` (cancelled batches included) and the row survives as compliance evidence.
ALTER TYPE "public"."hope_submission_status" ADD VALUE IF NOT EXISTS 'cancelled';
ALTER TYPE "public"."hope_submission_item_status" ADD VALUE IF NOT EXISTS 'cancelled';

ALTER TABLE "hope_submission"
  ADD COLUMN IF NOT EXISTS "cancelled_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "cancelled_by_membership_id" uuid,
  ADD COLUMN IF NOT EXISTS "cancel_reason_code" text
    CONSTRAINT "hope_submission_cancel_reason_code_check"
    CHECK ("cancel_reason_code" IN ('package_lost', 'never_uploaded', 'generated_in_error', 'other'))
    CONSTRAINT "hope_submission_cancelled_provenance_check"
    CHECK (num_nonnulls("cancelled_at", "cancelled_by_membership_id", "cancel_reason_code")
      = CASE WHEN "status"::text = 'cancelled' THEN 3 ELSE 0 END);

CREATE INDEX IF NOT EXISTS "idx_sfv_org_status_updated" ON "symptom_follow_up_visit" ("organization_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "idx_hope_sched_org_status_updated" ON "hope_timepoint_schedule" ("organization_id", "status", "updated_at");
