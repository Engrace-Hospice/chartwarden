-- GAP-093(b) — M31 telehealth: record WHO started a recording so stop-recording is starter-only.
--
-- Additive, nullable, no default: recordings started before this migration have an UNKNOWN starter (NULL),
-- for which stop-recording keeps its assigned-clinician fallback; the org-admin halt route stays the
-- override. The value is the session user id of the clinician who started the recording (server-derived,
-- never a body field), set by start-recording and kept on stop for the audit trail.
--
-- A user id is not PHI and not free text: it is NOT added to the telehealth_visit audit denylist
-- (0139 trigger function is unchanged). Existing RLS (org_id GUC) and grants cover the new column.
ALTER TABLE "telehealth_visit" ADD COLUMN IF NOT EXISTS "recording_started_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "telehealth_visit" DROP CONSTRAINT IF EXISTS "telehealth_visit_recording_started_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "telehealth_visit" ADD CONSTRAINT "telehealth_visit_recording_started_by_user_id_fk"
  FOREIGN KEY ("recording_started_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict;
