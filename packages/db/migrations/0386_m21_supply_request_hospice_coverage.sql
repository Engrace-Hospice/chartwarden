-- COP27 workstream B (42 CFR 418.24(b)(6)/(c)) — the hospice coverage determination on M21 `supply_request`.
--
-- The election statement addendum (§ 418.24(c)(5)) must list the ITEMS the hospice determined are not covered
-- (unrelated to the terminal prognosis, or otherwise not hospice-covered) with a reason. DME and supplies are
-- ordered as `supply_request` rows (module manifest: M21 owns the table; M11 orders fan out into it via
-- `source_order_id`), so the determination lives on the request and M6's addendum reads the not-covered rows
-- through M21's `NonCoveredDmeSuppliesReader` seam.
--
-- Same four columns, default and CHECK as migration 0385 (medication_order), for the same reasons:
--   * existing rows default to `covered_related` — § 418.24(b)(3) makes related/covered the presumption and
--     "not covered" an exception the hospice must positively determine; every existing request was placed by
--     the hospice for the patient's plan of care, and inventing a "not covered" line on a patient's addendum
--     would be a coverage denial nobody decided. Backfilled rows keep `coverage_determined_at` NULL.
--   * `m21_supply_request_coverage_reason` — not covered ⇒ non-blank reason + determination instant.
-- PLUS `m21_supply_request_coverage_kind`: only the `dme` / `supply` kinds may be marked not covered. A comfort
-- kit (deploy / replenish) is the hospice's own symptom-management medication supply by construction; a drug
-- inside it that the hospice deems unrelated is determined on its M12 `medication_order`, not on the kit.
--
-- AUDIT: `coverage_reason` is NOT added to migration 0106/0268's denylist (`audit_phi_write_supply_request`):
-- it is the explanation the hospice must disclose to the patient and other providers (§ 418.24(c)(6), (c)(9)),
-- and the audit after-image is the evidence of the determination. The trigger snapshots `to_jsonb(NEW)`, so
-- the new columns are captured with no trigger change, and `M21_AUDIT_DENYLIST` is unchanged (sync gate).
--
-- `supply_request` is PARTITION BY RANGE (created_at) (0104): parent-level DDL propagates to every leaf.
-- The `hospice_coverage` type is created by 0385.
ALTER TABLE "supply_request"
  ADD COLUMN IF NOT EXISTS "hospice_coverage" "hospice_coverage" NOT NULL DEFAULT 'covered_related';
ALTER TABLE "supply_request"
  ADD COLUMN IF NOT EXISTS "coverage_reason" text;
ALTER TABLE "supply_request"
  ADD COLUMN IF NOT EXISTS "coverage_determined_at" timestamp with time zone;
ALTER TABLE "supply_request"
  ADD COLUMN IF NOT EXISTS "coverage_determined_by_membership_id" uuid;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'm21_supply_request_coverage_reason'
      AND conrelid = 'supply_request'::regclass
  ) THEN
    ALTER TABLE "supply_request"
      ADD CONSTRAINT "m21_supply_request_coverage_reason"
      CHECK (
        "hospice_coverage" = 'covered_related'
        OR ("coverage_reason" IS NOT NULL AND btrim("coverage_reason") <> '' AND "coverage_determined_at" IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'm21_supply_request_coverage_kind'
      AND conrelid = 'supply_request'::regclass
  ) THEN
    ALTER TABLE "supply_request"
      ADD CONSTRAINT "m21_supply_request_coverage_kind"
      CHECK ("hospice_coverage" = 'covered_related' OR "kind" IN ('dme', 'supply'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "supply_request_admission_not_covered_idx"
  ON "supply_request" ("organization_id", "admission_id")
  WHERE "hospice_coverage" <> 'covered_related';
