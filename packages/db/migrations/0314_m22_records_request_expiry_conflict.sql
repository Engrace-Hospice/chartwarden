-- M22 — DocLens records requests: expiry, and a persisted code conflict on the returned batch (F-238).
--
-- 1. intake_records_request.expires_on — the calendar day after which an unanswered request (`requested`)
--    is moved to `expired` by the hourly M22 sweep (`m22.records_request_expiry`). Set at create (default:
--    30 days after the due date, or after the request day when there is none); staff may extend it, which
--    re-opens an expired request. NULL = never expires (rows created before this migration that the
--    backfill could not see).
--    intake_records_request.expired_at — when the sweep expired it. KEPT after records arrive anyway, so
--    `received_at >= expired_at` says "arrived after expiry" (records are never refused for lateness: the
--    code still files the batch). Cleared when staff extend the request.
-- 2. intake_upload_batch.records_request_conflict_id / _kind — the intake job found a records-request code
--    on the pages that names ANOTHER referral / patient than the one the batch was already filed under. The
--    batch is not moved; the conflict is kept here so the review workspace, the review queue and the
--    referral's Records tab can warn. Cleared when the batch is relinked to the request's referral.
-- Idempotent.
ALTER TABLE "intake_records_request"
  ADD COLUMN IF NOT EXISTS "expires_on" date;--> statement-breakpoint
ALTER TABLE "intake_records_request"
  ADD COLUMN IF NOT EXISTS "expired_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "intake_records_request" ADD CONSTRAINT "intake_records_request_expired_shape"
    CHECK ("status" <> 'expired' OR "expired_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- Backfill (rows only exist where 0313 already ran). The sweep ignores NULL, so a row this cannot reach
-- simply never expires.
UPDATE "intake_records_request"
  SET "expires_on" = COALESCE("due_date", ("requested_at" AT TIME ZONE 'UTC')::date) + 30
  WHERE "expires_on" IS NULL;--> statement-breakpoint
-- The sweep's scan: open requests by expiry day, per org.
CREATE INDEX IF NOT EXISTS "intake_records_request_org_open_expiry_idx"
  ON "intake_records_request" ("organization_id", "expires_on")
  WHERE "status" = 'requested' AND "expires_on" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "intake_upload_batch"
  ADD COLUMN IF NOT EXISTS "records_request_conflict_id" uuid;--> statement-breakpoint
ALTER TABLE "intake_upload_batch"
  ADD COLUMN IF NOT EXISTS "records_request_conflict_kind" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "intake_upload_batch" ADD CONSTRAINT "intake_upload_batch_records_request_conflict_fk"
    FOREIGN KEY ("records_request_conflict_id") REFERENCES "intake_records_request"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "intake_upload_batch" ADD CONSTRAINT "intake_upload_batch_records_request_conflict_chk"
    CHECK (
      ("records_request_conflict_id" IS NULL) = ("records_request_conflict_kind" IS NULL)
      AND ("records_request_conflict_kind" IS NULL
        OR "records_request_conflict_kind" IN ('code_names_another_referral', 'code_names_another_patient'))
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
