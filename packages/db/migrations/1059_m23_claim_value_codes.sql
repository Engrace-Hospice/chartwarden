-- M23 — the claim's wage-index value codes (UB-04 FL 39-41 / 837I HI*BE): `61` = the CBSA (or rural 999NN / transition
-- 5000N code) of the beneficiary's residence at the end of the billing period, on home levels of care (revenue 0651/0652);
-- `G8` = the CBSA of the latest inpatient facility, on 0655/0656 (CMS Pub. 100-04 ch. 11 §30.3). The pricer wage-adjusts
-- with them. Stored as [{"code":"61","cbsaCode":"31084"}]; resolved from the patient's ZIP via the platform geography
-- tables (migration 1058) at assembly and refreshed on every re-validation. NULL/empty = nothing resolved; the
-- `cbsa_value_codes_present` rule blocks a claim whose required code could not be resolved. Codes only (no PHI, no
-- address). `claim` is LIST-partitioned: ADD COLUMN on the parent propagates. Idempotent.
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "value_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_value_codes_array_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_value_codes_array_chk" CHECK (jsonb_typeof("value_codes") = 'array');
  END IF;
END $$;
