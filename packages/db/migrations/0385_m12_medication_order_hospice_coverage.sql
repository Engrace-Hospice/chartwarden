-- COP27 workstream B (42 CFR 418.24(b)(6)/(c), in force for elections on or after 2026-10-01) — the hospice
-- coverage determination on every M12 `medication_order`.
--
-- The mandatory election statement addendum ("Patient Notification of Hospice Non-Covered Items, Services,
-- and Drugs", § 418.24(c)) must list the drugs the hospice has determined are unrelated to the terminal
-- illness and related conditions (or otherwise not covered), each with a clinical explanation the patient
-- can understand (§ 418.24(c)(5)-(6)). `medication_order` is the source of truth for every hospice-prescribed
-- drug (module manifest: M12 owns it), so the determination lives here and M6's addendum reads the
-- not-covered rows through M12's `NonCoveredMedicationsReader` seam — never M12's schema.
--
-- Columns:
--   hospice_coverage                       hospice_coverage NOT NULL DEFAULT 'covered_related'
--   coverage_reason                        text      — the patient-facing explanation (§ 418.24(c)(6))
--   coverage_determined_at                 timestamptz — NULL = never explicitly determined
--   coverage_determined_by_membership_id   uuid      — the acting membership (session-derived); logical ref,
--                                                      no FK (the M12 partitioned-table convention)
--
-- WHY EXISTING ROWS DEFAULT TO `covered_related` (the ADD COLUMN default backfills every partition):
--   * § 418.24(b)(3) — "services unrelated to the terminal illness and related conditions are exceptional and
--     unusual and hospice should be providing virtually all care needed by the individual". Related/covered
--     is the regulatory presumption; "not covered" is the exception that must be positively determined.
--   * Every existing order was written by the hospice under that presumption — it was prescribed by the
--     hospice, which is itself evidence the hospice treated it as part of the plan of care. Back-filling
--     anything else would invent a clinical determination nobody made, and printing an invented "not covered"
--     line on a patient's addendum is a denial of coverage the beneficiary never received.
--   * The backfilled rows carry `coverage_determined_at` NULL, so "presumed related (never reviewed)" stays
--     distinguishable from "a clinician affirmatively determined it related".
--
-- CHECK `medication_order_coverage_reason_chk`: a NOT-covered value requires a non-blank reason AND a
-- determination instant (the app enforces the same rule first — `validateCoverageDetermination` in
-- @chartwarden/types — this is the backstop). PostgreSQL validates the CHECK against every existing row, which
-- are all `covered_related` after the default, so the ADD never fails.
--
-- AUDIT: `coverage_reason` is NOT added to the M4 write-audit denylist. It is the explanation the hospice is
-- REQUIRED to hand to the patient, non-hospice providers and Medicare contractors (§ 418.24(c)(6), (c)(9)), and
-- the audit after-image is the surveyor's evidence of who determined what, when (the `m12.medication.error_
-- reported.summary` precedent). The existing trigger already snapshots `to_jsonb(NEW)`, so no trigger change.
--
-- `medication_order` is PARTITION BY RANGE (created_at): ADD COLUMN / ADD CONSTRAINT / CREATE INDEX on the
-- parent propagate to every partition. Idempotent (IF NOT EXISTS / guarded DO blocks).
DO $$ BEGIN
  CREATE TYPE "public"."hospice_coverage" AS ENUM ('covered_related', 'not_covered_unrelated', 'not_covered_other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "medication_order"
  ADD COLUMN IF NOT EXISTS "hospice_coverage" "hospice_coverage" NOT NULL DEFAULT 'covered_related';
ALTER TABLE "medication_order"
  ADD COLUMN IF NOT EXISTS "coverage_reason" text;
ALTER TABLE "medication_order"
  ADD COLUMN IF NOT EXISTS "coverage_determined_at" timestamp with time zone;
ALTER TABLE "medication_order"
  ADD COLUMN IF NOT EXISTS "coverage_determined_by_membership_id" uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'medication_order_coverage_reason_chk'
      AND conrelid = 'medication_order'::regclass
  ) THEN
    ALTER TABLE "medication_order"
      ADD CONSTRAINT "medication_order_coverage_reason_chk"
      CHECK (
        "hospice_coverage" = 'covered_related'
        OR ("coverage_reason" IS NOT NULL AND btrim("coverage_reason") <> '' AND "coverage_determined_at" IS NOT NULL)
      );
  END IF;
END $$;

-- The NonCoveredMedicationsReader read: one admission's not-covered rows (a small minority by design).
CREATE INDEX IF NOT EXISTS "medication_order_admission_not_covered_idx"
  ON "medication_order" ("organization_id", "admission_id")
  WHERE "hospice_coverage" <> 'covered_related';
