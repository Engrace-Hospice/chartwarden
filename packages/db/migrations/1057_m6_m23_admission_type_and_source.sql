-- M6 / M23 — the UB-04 Type of Admission (FL 14 → 837I CL101) and Point of Origin (FL 15 → CL102) a hospice claim carries.
--
-- Both are REQUIRED on a hospice claim (not on the NOE) — CGS "Hospice Medicare Billing Codes Sheet", CMS Pub. 100-04 ch. 25
-- §75.1 — and Stedi's 837I API rejects an institutional claim without the admission source. They are facts about the
-- admission, so M6 owns them; M23 snapshots them onto the claim at assembly and refreshes them on every re-validation.
--
--   admission.admission_type_code    '1' emergency · '2' urgent · '3' elective · '5' trauma · '9' information not available
--   admission.admission_source_code  '1' non-health care facility · '2' clinic / physician office · '4' transfer from a hospital
--                                    · '5' transfer from a SNF / ICF · '6' transfer from another health care facility
--                                    · '8' court / law enforcement · '9' information not available
--   claim.admission_type_code / claim.admission_source_code   the snapshot of the same two values (the 837I CL1 inputs)
--
-- NULLABLE on purpose: existing admissions carry neither, and inventing a value for a historical admission would put a made-up
-- code on a federal claim. A NULL fails the M23 `admission_codes_present` rule on a claim (blocking, regulatory) until a
-- biller records the real value on the admission. The CHECKs bound the value sets. Codes only (no PHI). `claim` is
-- LIST-partitioned: ADD COLUMN / ADD CONSTRAINT on the parent propagate to every partition. The existing org RLS policies,
-- FORCE RLS and write-audit triggers cover the new columns. Idempotent.
ALTER TABLE "admission" ADD COLUMN IF NOT EXISTS "admission_type_code" text;--> statement-breakpoint
ALTER TABLE "admission" ADD COLUMN IF NOT EXISTS "admission_source_code" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "admission_type_code" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "admission_source_code" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_admission_type_code_chk') THEN
    ALTER TABLE "admission" ADD CONSTRAINT "admission_admission_type_code_chk"
      CHECK ("admission_type_code" IS NULL OR "admission_type_code" IN ('1', '2', '3', '5', '9'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admission_admission_source_code_chk') THEN
    ALTER TABLE "admission" ADD CONSTRAINT "admission_admission_source_code_chk"
      CHECK ("admission_source_code" IS NULL OR "admission_source_code" IN ('1', '2', '4', '5', '6', '8', '9'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_admission_type_code_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_admission_type_code_chk"
      CHECK ("admission_type_code" IS NULL OR "admission_type_code" IN ('1', '2', '3', '5', '9'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_admission_source_code_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_admission_source_code_chk"
      CHECK ("admission_source_code" IS NULL OR "admission_source_code" IN ('1', '2', '4', '5', '6', '8', '9'));
  END IF;
END $$;
