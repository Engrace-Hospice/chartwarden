-- GAP-158 — the caregiver -> M2 user link.
--
-- The M31 `portal_caregiver_is_primary_or_dpoa` ABAC read (`PatientCaregiverReader.primaryCaregiverUserId`) was a
-- deny-stub because no schema link existed between a `caregiver` (a person on a patient's roster) and the M2 user
-- who signs into the portal: family caregivers could never pass the caregiver-attestation gate. The link is a nullable
-- logical user id on `caregiver`, stamped when a portal invitation issued FOR that caregiver is accepted (the accept
-- transaction calls M5's `linkCaregiverToUserInTx`). Logical FK (no DB FK across the M2 edge, the platform policy);
-- NULL = the caregiver has not (yet) claimed a portal login. Additive; the table's FORCEd RLS, grants and audit trigger
-- already cover the new column (a user id is not PHI by itself).
ALTER TABLE "caregiver" ADD COLUMN IF NOT EXISTS "user_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "caregiver_user_idx" ON "caregiver" ("organization_id", "user_id") WHERE "user_id" IS NOT NULL;
