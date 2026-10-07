-- GAP-095 — M31 telehealth lifecycle vs the vendor: persist what the leave / start-recording / end routes
-- used to discard.
--
--   patient_left_at / clinician_left_at — the portal/staff `leave` routes stored nothing, so `end` could not
--     tell who was still present (it hard-coded patientPresentAtEnd = false). A re-join clears the column.
--   vendor_recording_id — `start-recording` discarded the vendor's recording id, so stop-recording could not
--     address the recording. It is an opaque vendor-issued id (not PHI, not free text, not a secret) so it is
--     NOT added to the telehealth_visit audit denylist (0139 trigger function unchanged).
--
-- Additive, nullable, no default: rows minted before this migration read NULL (= present / no recording id).
-- Existing RLS (org_id GUC) and grants cover the new columns.
ALTER TABLE "telehealth_visit" ADD COLUMN IF NOT EXISTS "patient_left_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telehealth_visit" ADD COLUMN IF NOT EXISTS "clinician_left_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telehealth_visit" ADD COLUMN IF NOT EXISTS "vendor_recording_id" text;
