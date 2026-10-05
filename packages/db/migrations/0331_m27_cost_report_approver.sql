-- GAP-081 — M27 cost-report two-person control: record WHO approved a report for submit.
--
-- approve_for_submit now stamps approved_by_membership_id / approved_at server-side (the authenticated
-- actor, never the request body); submit compares the submitter against it and refuses an equal pair.
-- Return-to-draft and reopen clear both columns (a new approval is required).
--
-- Back-compat: reports already in approved_for_submit when this lands keep approved_by_membership_id NULL.
-- Submit REFUSES a NULL approver (409 APPROVER_NOT_RECORDED) — the report must be returned to draft and
-- re-approved. No backfill is attempted: the approver of a pre-existing approval is not reliably recoverable.
-- Both columns are nullable, additive, no default; the existing RLS policies and the audit trigger
-- (to_jsonb(NEW), scrubbed by the M4 generator) cover them unchanged.
ALTER TABLE "cost_report" ADD COLUMN IF NOT EXISTS "approved_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "cost_report" ADD COLUMN IF NOT EXISTS "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cost_report" DROP CONSTRAINT IF EXISTS "cost_report_approved_pair_chk";--> statement-breakpoint
ALTER TABLE "cost_report" ADD CONSTRAINT "cost_report_approved_pair_chk"
  CHECK ((approved_by_membership_id IS NULL) = (approved_at IS NULL));--> statement-breakpoint
