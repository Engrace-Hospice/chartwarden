-- M6 §2.3.4 / FY2027 hospice CoP (CMS-1851-F) — R-F2F-05: telehealth recertification face-to-face.
-- 42 CFR 418.22(a)(4)(ii) permits a telehealth recert F2F through 2027-12-31 and, from 2026-01-31, bars it
-- when (A) the patient is in a hospice enrollment-moratorium area, (B) the hospice is under enhanced
-- oversight, or (C) the performer is neither Medicare-enrolled nor an opt-out practitioner. WardenX has no
-- moratorium / oversight / practitioner-enrollment registry, so the completing clinician attests the three
-- facts explicitly; the attestation is persisted here for audit
-- (docs/research/FY2027_HOSPICE_COP_RESEARCH.md §3).
--
--   telehealth_eligibility   {patientInMoratoriumArea, hospiceUnderEnhancedOversight,
--                             performerMedicareEnrolledOrOptedOut, attestedAt}; NULL unless the
--                             encounter_location is 'telehealth'.
--
-- Additive + nullable (no PHI: three booleans and an instant). The existing org RLS policy, FORCE RLS and the
-- M4 write-audit trigger on face_to_face_encounter cover the new column. `encounter_location` (already in the
-- table since M6-T03) is now written by POST /face-to-face/:id/complete, and `encounter_id` by the R-F2F-06
-- signed-note attestation path.
ALTER TABLE "face_to_face_encounter" ADD COLUMN IF NOT EXISTS "telehealth_eligibility" jsonb;--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" DROP CONSTRAINT IF EXISTS "f2f_telehealth_eligibility_ck";--> statement-breakpoint
ALTER TABLE "face_to_face_encounter" ADD CONSTRAINT "f2f_telehealth_eligibility_ck"
  CHECK (
    telehealth_eligibility IS NULL
    OR (
      encounter_location = 'telehealth'
      AND jsonb_typeof(telehealth_eligibility) = 'object'
    )
  );
