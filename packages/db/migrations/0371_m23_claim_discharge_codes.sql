-- M23 — persist the discharge-driven claim codes on `claim` (CMS Pub. 100-04 Ch. 11 §30.3; Transmittal 2410 / CR 7677):
--
--   patient_status_code  UB-04 FL 17 / 837I CL103: 01, 30, 40, 41, 42, 50, 51. NULL = could not be derived (death
--                        with no place of death, transfer with no receiving care setting, a discharge reason with no
--                        CMS coding); the `bereavement_discharge_legitimacy` rule blocks such a claim.
--   condition_codes      UB-04 FL 18-28 / HI*BG: a JSON array of codes ('52', 'H2').
--   occurrence_codes     UB-04 FL 31-34 / HI*BH: a JSON array of {"code": '42'|'55', "date": 'YYYY-MM-DD'}.
--
-- Written at assembly and refreshed on every re-validation; sent to the X12 gateway in the generate-837i claim
-- document. Existing claims keep NULL / [] until their next validation run. Codes and dates only (no PHI). `claim`
-- is LIST-partitioned: ADD COLUMN / ADD CONSTRAINT on the parent propagate to every partition. The existing org RLS
-- policy, FORCE RLS and write-audit trigger cover the new columns. Idempotent.
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "patient_status_code" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "condition_codes" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "occurrence_codes" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_patient_status_code_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_patient_status_code_chk"
      CHECK ("patient_status_code" IS NULL OR "patient_status_code" IN ('01', '30', '40', '41', '42', '50', '51'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_condition_codes_array_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_condition_codes_array_chk"
      CHECK (jsonb_typeof("condition_codes") = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_occurrence_codes_array_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_occurrence_codes_array_chk"
      CHECK (jsonb_typeof("occurrence_codes") = 'array');
  END IF;
END $$;
