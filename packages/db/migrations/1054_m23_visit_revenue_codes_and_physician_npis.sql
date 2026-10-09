-- M23 — hospice visit claim lines and the physician NPIs an 837I needs (CMS Pub. 100-04 ch. 11 §30.3).
--
-- 1. `claim_line_revenue_code` gains the visit revenue codes. Hospice claims report every visit by hospice
--    staff as its own dated line, in 15-minute units, under a discipline revenue code with a G-code:
--      0421 physical therapy (G0151)         0431 occupational therapy (G0152)   0441 speech-language pathology (G0153)
--      0551 skilled nursing (G0299 RN / G0300 LPN)
--      0561 medical social services visit (G0155)   0569 social worker phone call (G0155)
--      0571 hospice aide (G0156)
--    The MAC prices the end-of-life Service Intensity Add-on from the 0551 (G0299) and 0561 (G0155) lines. The HCPCS
--    rides the existing `hcpcs_code` column; a visit line rides the covering level-of-care period like the G0679 line.
--    NAME NOTE: the DB type is `claim_line_revenue_code` (un-prefixed, per M23 spec §3.3). Idempotent; the new values
--    are not used by any statement in this file.
-- 2. `claim.attending_physician_npi` / `claim.certifying_physician_npi` (UB-04 FL 76 / FL 78): provider identifiers
--    (not patient data), derived at assembly from M40's resolution and refreshed on every re-validation like the
--    discharge codes. The certifying NPI is only set when it differs from the attending (FISS footnote 6). Names are
--    resolved at generation time, never stored. NULL = not resolved; the `physician_credentials_active` rule blocks.
--
-- `claim` is LIST-partitioned: ADD COLUMN / ADD CONSTRAINT on the parent propagate to every partition. The existing org
-- RLS policy, FORCE RLS and write-audit trigger cover the new columns. Idempotent.
ALTER TYPE "public"."claim_line_revenue_code" ADD VALUE IF NOT EXISTS '0421';--> statement-breakpoint
ALTER TYPE "public"."claim_line_revenue_code" ADD VALUE IF NOT EXISTS '0431';--> statement-breakpoint
ALTER TYPE "public"."claim_line_revenue_code" ADD VALUE IF NOT EXISTS '0441';--> statement-breakpoint
ALTER TYPE "public"."claim_line_revenue_code" ADD VALUE IF NOT EXISTS '0551';--> statement-breakpoint
ALTER TYPE "public"."claim_line_revenue_code" ADD VALUE IF NOT EXISTS '0561';--> statement-breakpoint
ALTER TYPE "public"."claim_line_revenue_code" ADD VALUE IF NOT EXISTS '0569';--> statement-breakpoint
ALTER TYPE "public"."claim_line_revenue_code" ADD VALUE IF NOT EXISTS '0571';--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "attending_physician_npi" text;--> statement-breakpoint
ALTER TABLE "claim" ADD COLUMN IF NOT EXISTS "certifying_physician_npi" text;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_attending_physician_npi_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_attending_physician_npi_chk"
      CHECK ("attending_physician_npi" IS NULL OR "attending_physician_npi" ~ '^[0-9]{10}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claim_certifying_physician_npi_chk') THEN
    ALTER TABLE "claim" ADD CONSTRAINT "claim_certifying_physician_npi_chk"
      CHECK ("certifying_physician_npi" IS NULL OR "certifying_physician_npi" ~ '^[0-9]{10}$');
  END IF;
END $$;
