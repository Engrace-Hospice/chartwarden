-- GAP-020 -- M13: record WHAT the wristband check concluded, keep the wrong-patient near miss, and let a tenant
-- say whether a wristband scan is required.
--
-- 1. barcode_scan_event gains the verdict M5's PatientWristbandVerifier returned (`wristband_check`), the
--    generation matched, and -- for a scan of ANOTHER patient's band -- that patient's id (the QAPI near-miss).
--    It also gains `patient_id` / `medication_order_id`: a REFUSED scan now persists a row of its own
--    (`administration_record_id` NULL, written in a separate committed transaction before the refusal is
--    thrown) so a caught wrong-patient scan no longer vanishes in the rolled-back write. `match_result` stays a
--    free `text` (no CHECK, 0040): every non-verified wristband outcome maps to `wrong_patient`.
--    All new columns are nullable: pre-existing rows predate the verifier.
-- 2. administration_policy.bcma_wristband_required (default TRUE, fail closed): when a BCMA scan is submitted,
--    M5 must return `verified` for the patient's wristband or the scan is refused. A tenant with no wristband
--    stock (home-only hospice) sets it FALSE; even then a band that WAS scanned and is wrong is still refused.
--    NOTE this is the wristband arm only: it does not make a scan mandatory (an administration recorded with no
--    barcodeScan at all is unchanged).
--
-- Idempotent.

ALTER TABLE "barcode_scan_event"
  ADD COLUMN IF NOT EXISTS "wristband_check" text,
  ADD COLUMN IF NOT EXISTS "wristband_generation" integer,
  ADD COLUMN IF NOT EXISTS "wristband_matched_patient_id" uuid,
  ADD COLUMN IF NOT EXISTS "patient_id" uuid,
  ADD COLUMN IF NOT EXISTS "medication_order_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "barcode_scan_event" ADD CONSTRAINT "barcode_scan_event_wristband_check_chk"
    CHECK ("wristband_check" IS NULL OR "wristband_check" IN
      ('verified','mismatch','not_presented','not_on_file','superseded','voided','malformed','skipped_policy_off'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
-- QAPI near-miss review: every scan whose wristband did not verify, newest first, per tenant.
CREATE INDEX IF NOT EXISTS "barcode_scan_event_near_miss_idx"
  ON "barcode_scan_event" ("organization_id", "created_at" DESC)
  WHERE "match_result" = 'wrong_patient';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "barcode_scan_event_patient_idx"
  ON "barcode_scan_event" ("organization_id", "patient_id")
  WHERE "patient_id" IS NOT NULL;--> statement-breakpoint

ALTER TABLE "administration_policy"
  ADD COLUMN IF NOT EXISTS "bcma_wristband_required" boolean DEFAULT true NOT NULL;
