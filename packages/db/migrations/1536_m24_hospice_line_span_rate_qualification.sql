-- compat: contract
-- M24-1075-L2: preserve exact claim-line DOS spans and prevent old, geography-free national Medicare
-- rate seeds from being selected as Oregon/EOCCO reimbursement. Existing claim financial snapshots and
-- legacy line ranges are intentionally not rewritten; NULL service_date_to means the historical span is
-- unknown. No rate row is promoted to verified by this migration.
ALTER TABLE medicaid_claim_line
  ADD COLUMN service_date_to timestamp with time zone;--> statement-breakpoint
ALTER TABLE medicaid_claim_line
  ADD CONSTRAINT medicaid_claim_line_service_range_valid
  CHECK (service_date_to IS NULL OR service_date <= service_date_to);--> statement-breakpoint
COMMENT ON COLUMN medicaid_claim_line.service_date_to IS
  'Inclusive line service-through date. NULL is retained for historical lines whose span cannot be reconstructed safely.';--> statement-breakpoint

ALTER TABLE medicaid_state_rate_schedule
  ADD COLUMN canonical_payer_id uuid,
  ADD COLUMN rate_source_kind text NOT NULL DEFAULT 'legacy_unqualified',
  ADD COLUMN verification_status text NOT NULL DEFAULT 'unverified';--> statement-breakpoint
ALTER TABLE medicaid_state_rate_schedule
  ADD CONSTRAINT medicaid_state_rate_schedule_source_kind_valid
    CHECK (rate_source_kind IN ('legacy_unqualified', 'oha_ffs_schedule')),
  ADD CONSTRAINT medicaid_state_rate_schedule_verification_status_valid
    CHECK (verification_status IN ('unverified', 'verified', 'expired', 'revoked')),
  ADD CONSTRAINT medicaid_state_rate_schedule_verified_payer
    CHECK (verification_status <> 'verified' OR
      (canonical_payer_id IS NOT NULL AND rate_source_kind = 'oha_ffs_schedule'));--> statement-breakpoint
ALTER TABLE medicaid_state_rate_schedule DROP CONSTRAINT medicaid_state_rate_schedule_uq;--> statement-breakpoint
ALTER TABLE medicaid_state_rate_schedule ADD CONSTRAINT medicaid_state_rate_schedule_uq
  UNIQUE (state_code, level_of_care, canonical_payer_id, county_code, effective_from);--> statement-breakpoint
COMMENT ON COLUMN medicaid_state_rate_schedule.rate_source_kind IS
  'Source class; existing CMS-derived seed rows remain legacy_unqualified and are not usable for Medicaid prices.';--> statement-breakpoint
COMMENT ON COLUMN medicaid_state_rate_schedule.verification_status IS
  'Source review status; this migration verifies no rows and M24 priced assembly remains disabled until full policy inputs are implemented.';--> statement-breakpoint
CREATE INDEX medicaid_state_rate_schedule_verified_payer_range_ix
  ON medicaid_state_rate_schedule (state_code, canonical_payer_id, level_of_care, effective_from, effective_to)
  WHERE verification_status = 'verified';
--> statement-breakpoint

-- Extend the established line-parent date guard to cover the inclusive through-date as well as the anchor.
CREATE OR REPLACE FUNCTION trg_fn_medicaid_claim_line_service_date_within_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_from timestamptz; v_to timestamptz;
BEGIN
  SELECT service_from, service_to INTO v_from, v_to
  FROM medicaid_claim
  WHERE id = NEW.medicaid_claim_id AND provider_entity_id = NEW.provider_entity_id;
  IF v_from IS NULL THEN
    RAISE EXCEPTION 'medicaid_claim_line.medicaid_claim_id % not found for provider_entity %', NEW.medicaid_claim_id, NEW.provider_entity_id;
  END IF;
  IF NEW.service_date < v_from OR NEW.service_date > v_to OR
     (NEW.service_date_to IS NOT NULL AND (NEW.service_date_to < v_from OR NEW.service_date_to > v_to)) THEN
    RAISE EXCEPTION 'medicaid_claim_line service range [% , %] outside claim range [% , %]', NEW.service_date, NEW.service_date_to, v_from, v_to;
  END IF;
  RETURN NEW;
END $$;
