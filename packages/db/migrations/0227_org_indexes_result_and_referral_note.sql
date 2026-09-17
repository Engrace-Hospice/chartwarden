-- WardenX — tenant-leading indexes for the final M6/M10 tables.
-- These tables are RLS-scoped, so organization_id must be in the seekable prefix.
CREATE INDEX IF NOT EXISTS "hope_submission_result_event_org_created_idx"
  ON "hope_submission_result_event" ("organization_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "referral_note_org_created_idx"
  ON "referral_note" ("organization_id", "created_at");
