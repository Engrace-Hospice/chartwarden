-- M23 — persist the two-tier RHC day-count carry-over a claim was priced with on `hipps_calculation`
-- (Claims Processing Manual ch. 11 §30.2; CR 9201 / Transmittal R3326CP):
--
--   rhc_carry_over  jsonb, NULLABLE. The prior hospice days carried into this stay's RHC day count (days 1–60
--                   high rate, 61+ low): `priorDays` (capped at 60), the counted `chain` of earlier stays (ours,
--                   and other hospices' from the HETS 271 history, with dates and NPIs), the `basis`
--                   (`internal_only` / `hets_merged` / `hets_stale`), the HETS check it read and any warnings.
--                   Written once at assembly (the table is append-only); NULL on rows priced before this.
--
-- Dates, counts, NPIs and codes only (no PHI / MBI). The existing org RLS policy, FORCE RLS and the append-only
-- write-audit trigger cover the new column. Idempotent. (0375 is reserved for the M23 8xC transfer-notice work.)
ALTER TABLE "hipps_calculation" ADD COLUMN IF NOT EXISTS "rhc_carry_over" jsonb;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hipps_calculation_rhc_carry_over_object_chk') THEN
    ALTER TABLE "hipps_calculation" ADD CONSTRAINT "hipps_calculation_rhc_carry_over_object_chk"
      CHECK ("rhc_carry_over" IS NULL OR jsonb_typeof("rhc_carry_over") = 'object');
  END IF;
END $$;
