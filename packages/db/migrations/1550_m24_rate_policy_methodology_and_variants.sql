-- compat: contract
-- L8A.1: represent rate methodology explicitly, support the open-ended final election-day bucket,
-- and permit distinct quality-reporting variants without weakening exact identity uniqueness.
-- Existing rows receive unqualified defaults and remain ineligible for pricing. They are never
-- promoted: quality_reporting_applicability and quality_reporting_status are part of a correction's
-- identity (the supersession guard below), and a verified row may carry neither 'unqualified' nor
-- 'unknown' for them, so a legacy row cannot be corrected into a verified one. A source-backed rate is
-- recorded as a NEW identity; the legacy row stays as an unpriceable historic record. No historic rate
-- or claim amount is promoted or rewritten.
ALTER TABLE medicaid_payer_rate_policy
  ADD COLUMN pricing_method text NOT NULL DEFAULT 'unqualified',
  ADD COLUMN quantity_conversion_method text NOT NULL DEFAULT 'unqualified',
  ADD COLUMN minimum_duration_method text NOT NULL DEFAULT 'unqualified',
  ADD COLUMN minimum_clinical_minutes integer,
  ADD COLUMN methodology_version integer NOT NULL DEFAULT 1,
  ADD COLUMN rounding_mode text NOT NULL DEFAULT 'unqualified',
  ADD COLUMN rounding_boundary text NOT NULL DEFAULT 'unqualified',
  ADD COLUMN charge_ceiling_method text NOT NULL DEFAULT 'unqualified',
  ADD COLUMN charge_ceiling_boundary text NOT NULL DEFAULT 'unqualified',
  ADD COLUMN quality_reporting_applicability text NOT NULL DEFAULT 'unqualified';--> statement-breakpoint

ALTER TABLE medicaid_payer_rate_policy
  DROP CONSTRAINT medicaid_payer_rate_policy_bucket_valid;--> statement-breakpoint
ALTER TABLE medicaid_payer_rate_policy
  ADD CONSTRAINT medicaid_payer_rate_policy_bucket_valid
    CHECK ((bucket_from IS NULL AND bucket_to IS NULL) OR
      (bucket_from IS NOT NULL AND bucket_from > 0 AND (bucket_to IS NULL OR bucket_to >= bucket_from))),
  ADD CONSTRAINT medicaid_payer_rate_policy_method_valid
    CHECK (pricing_method IN ('unqualified', 'per_day', 'per_hour', 'fixed_contract_unit')),
  ADD CONSTRAINT medicaid_payer_rate_policy_methodology_version_valid
    CHECK (methodology_version > 0),
  ADD CONSTRAINT medicaid_payer_rate_policy_quantity_conversion_valid
    CHECK (quantity_conversion_method IN ('unqualified', 'daily_units', 'hourly_prorated_minutes', 'hourly_each_hour_or_part')),
  ADD CONSTRAINT medicaid_payer_rate_policy_minimum_duration_valid
    CHECK ((minimum_duration_method IN ('unqualified', 'not_applicable', 'not_required') AND minimum_clinical_minutes IS NULL) OR
      (minimum_duration_method = 'minimum_minutes' AND minimum_clinical_minutes IS NOT NULL AND minimum_clinical_minutes > 0)),
  ADD CONSTRAINT medicaid_payer_rate_policy_rounding_mode_valid
    CHECK (rounding_mode IN ('unqualified', 'exact_only', 'half_up', 'half_even', 'floor', 'ceiling', 'not_applicable')),
  ADD CONSTRAINT medicaid_payer_rate_policy_rounding_boundary_valid
    CHECK (rounding_boundary IN ('unqualified', 'service_day', 'segment', 'line', 'claim', 'not_applicable')),
  ADD CONSTRAINT medicaid_payer_rate_policy_charge_ceiling_method_valid
    CHECK (charge_ceiling_method IN ('unqualified', 'none', 'lower_of_rate_and_usual_charge', 'contract_maximum')),
  ADD CONSTRAINT medicaid_payer_rate_policy_charge_ceiling_boundary_valid
    CHECK (charge_ceiling_boundary IN ('unqualified', 'service_day', 'segment', 'line', 'claim', 'not_applicable')),
  ADD CONSTRAINT medicaid_payer_rate_policy_quality_applicability_valid
    CHECK (quality_reporting_applicability IN ('unqualified', 'required', 'not_required'));--> statement-breakpoint

ALTER TABLE medicaid_payer_rate_policy
  DROP CONSTRAINT medicaid_payer_rate_policy_identity_uq;--> statement-breakpoint
ALTER TABLE medicaid_payer_rate_policy
  ADD CONSTRAINT medicaid_payer_rate_policy_identity_uq UNIQUE NULLS NOT DISTINCT
    (organization_id, provider_entity_id, canonical_payer_id, program_kind, service_state,
     locality_code, service_category, unit_basis, bucket_from, bucket_to,
     quality_reporting_applicability, quality_reporting_status, effective_from, supersedes_id);--> statement-breakpoint

-- NOT VALID preserves historical source records with the new unqualified defaults while enforcing the
-- complete methodology contract for every newly inserted or changed-to-verified row. Shape:
-- verified => (not respite AND qualified enums AND (ceiling) AND (pricing method) AND (OHA FFS rules)).
-- Every group is closed before the next AND, so the OHA rules bind per_day and per_hour rows too.
ALTER TABLE medicaid_payer_rate_policy
  ADD CONSTRAINT medicaid_payer_rate_policy_verified_methodology CHECK (
    verification_status <> 'verified' OR
    (service_category <> 'IN_HOME_RESPITE' AND
      pricing_method <> 'unqualified' AND quantity_conversion_method <> 'unqualified'
      AND minimum_duration_method <> 'unqualified' AND quality_reporting_applicability <> 'unqualified'
      AND quality_reporting_status <> 'unknown' AND rounding_mode <> 'unqualified'
      AND rounding_boundary <> 'unqualified' AND (
        (charge_ceiling_method = 'none' AND charge_ceiling_boundary = 'not_applicable') OR
        (charge_ceiling_method = 'lower_of_rate_and_usual_charge' AND charge_ceiling_boundary = 'service_day') OR
        (charge_ceiling_method = 'contract_maximum' AND charge_ceiling_cents IS NOT NULL
          AND charge_ceiling_boundary IN ('service_day', 'segment'))
      ) AND (
        (pricing_method = 'per_day' AND unit_basis = 'per_day'
          AND quantity_conversion_method = 'daily_units' AND minimum_duration_method = 'not_applicable') OR
        (pricing_method = 'per_hour' AND unit_basis = 'per_hour'
          AND quantity_conversion_method IN ('hourly_prorated_minutes', 'hourly_each_hour_or_part')
          AND minimum_duration_method IN ('not_required', 'minimum_minutes')) OR
        (pricing_method = 'fixed_contract_unit' AND
          ((unit_basis = 'per_day' AND quantity_conversion_method = 'daily_units' AND minimum_duration_method = 'not_applicable') OR
           (unit_basis = 'per_hour' AND quantity_conversion_method IN ('hourly_prorated_minutes', 'hourly_each_hour_or_part')
            AND minimum_duration_method IN ('not_required', 'minimum_minutes')))
      )) AND (
        source_kind <> 'oha_ffs_schedule' OR
        (program_kind = 'oregon_ffs' AND charge_ceiling_method = 'lower_of_rate_and_usual_charge'
          AND charge_ceiling_boundary = 'service_day' AND quality_reporting_applicability = 'required' AND
          (service_category <> 'CHC' OR
            (pricing_method = 'per_hour' AND unit_basis = 'per_hour'
              AND quantity_conversion_method = 'hourly_each_hour_or_part'
              AND minimum_duration_method = 'minimum_minutes' AND COALESCE(minimum_clinical_minutes, 0) = 480)))
      ))
  ) NOT VALID;--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_medicaid_payer_rate_policy_supersession() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_prior medicaid_payer_rate_policy%ROWTYPE;
BEGIN
  IF NEW.supersedes_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO v_prior FROM medicaid_payer_rate_policy
   WHERE id = NEW.supersedes_id AND organization_id = NEW.organization_id;
  IF NOT FOUND OR ROW(v_prior.provider_entity_id, v_prior.canonical_payer_id, v_prior.program_kind, v_prior.service_state,
                      v_prior.locality_code, v_prior.service_category, v_prior.unit_basis, v_prior.bucket_from,
                      v_prior.bucket_to, v_prior.quality_reporting_applicability, v_prior.quality_reporting_status,
                      v_prior.effective_from)
     IS DISTINCT FROM ROW(NEW.provider_entity_id, NEW.canonical_payer_id, NEW.program_kind, NEW.service_state,
                          NEW.locality_code, NEW.service_category, NEW.unit_basis, NEW.bucket_from,
                          NEW.bucket_to, NEW.quality_reporting_applicability, NEW.quality_reporting_status,
                          NEW.effective_from) THEN
    RAISE EXCEPTION 'medicaid_payer_rate_policy a correcting row must replace a row of the same identity and effective date'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint

COMMENT ON COLUMN medicaid_payer_rate_policy.pricing_method IS
  'Source-backed calculation method; unqualified rows cannot price claims.';--> statement-breakpoint
COMMENT ON COLUMN medicaid_payer_rate_policy.rounding_boundary IS
  'Methodology boundary for monetary rounding; claim-line rendering may use only separately qualified semantics.';--> statement-breakpoint
COMMENT ON COLUMN medicaid_payer_rate_policy.charge_ceiling_method IS
  'Explicit ceiling semantics; charge_ceiling_cents is not assumed to be provider usual charge.';--> statement-breakpoint
COMMENT ON COLUMN medicaid_payer_rate_policy.charge_ceiling_boundary IS
  'Explicit charge-ceiling application scope; line and claim scopes remain unqualified in L8A.1.';--> statement-breakpoint
COMMENT ON COLUMN medicaid_payer_rate_policy.quantity_conversion_method IS
  'Explicit conversion from clinical quantity to reimbursement quantity; does not define 837I units.';--> statement-breakpoint
COMMENT ON COLUMN medicaid_payer_rate_policy.minimum_duration_method IS
  'Source-backed hourly eligibility rule; null thresholds are explicit only for not_required or not_applicable.';--> statement-breakpoint
