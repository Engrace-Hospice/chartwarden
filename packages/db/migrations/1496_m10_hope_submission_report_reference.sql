-- compat: expand
-- M10 HOPE - the report reference of a recorded CMS result gets its own column on `hope_submission`.
-- Until now it lived only inside `acceptance_report->>'reportReference'`, and the "light" submission reads (the worklist, the
-- detail, every lock) projected it from there. A jsonb `->>` reads the whole value, and that value also holds the package ZIP
-- as base64 (multi-MB), so every batch of a worklist read pulled its ZIP out of TOAST just to show a reference of a few
-- characters. The code now writes both (the jsonb keeps the reference, so the previous release still reads it) and the light
-- reads select the column.
-- Additive only: one nullable column, no default, no constraint. The backfill is limited to batches a result was recorded
-- for (`result_imported_at`): a reference is written only by that import, so a packaged or cancelled batch has none and its
-- ZIP is not read. It never overwrites a value (`report_reference IS NULL`) and `updated_at` is not touched, so replaying
-- the file is harmless and a batch the previous release recorded a result for after this file ran is picked up on a replay.
-- The write-audit trigger fires on the backfill (an UPDATE is audited like any other); the new column is NOT scrubbed there:
-- it is the same operator-typed reference `hope_submission_result_event.report_reference` already carries into the audit
-- stream unscrubbed, and `acceptance_report` stays scrubbed.
ALTER TABLE "hope_submission" ADD COLUMN IF NOT EXISTS "report_reference" text;

UPDATE "hope_submission"
   SET "report_reference" = "acceptance_report"->>'reportReference'
 WHERE "result_imported_at" IS NOT NULL
   AND "report_reference" IS NULL
   AND "acceptance_report"->>'reportReference' IS NOT NULL;
